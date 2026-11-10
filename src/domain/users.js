import { withTransaction } from '../data/tx.js';
import {
  upsertUser, findById, findBySubject, findActiveByEmail, listUsers, updateProfile, anonymizeUser,
  deactivateMemberships, EmailTakenError,
} from '../data/users.js';
import { enqueueEvent, enqueueIdpTask } from '../data/outbox.js';
import { IdpConflictError, IdpNoEmailError, IdpNotFoundError } from '../idp/keycloak.js';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ForbiddenError extends Error {}

export const PLATFORM_ADMIN = 'platform-admin';

const emailTaken = () => new ConflictError('This email belongs to another account');
const mapEmailTaken = (err) => { throw err instanceof EmailTakenError ? emailTaken() : err; };

const profileUpdated = (client, userId, correlationId) => enqueueEvent(client, {
  type: 'identity.user.updated', key: userId, data: { userId }, correlationId,
});

// True when the provider holds a different profile than the local user
export const profileDiffers = (user, account) => Boolean(account.email) && (account.email !== user.email
  || account.givenName !== user.givenName || account.familyName !== user.familyName);

// Account lifecycle (ADR-0003). `idp` is the identity-provider adapter.
export const createUserService = ({ db, idp, logger }) => {
  // Anonymizes a user in one transaction: personal data erased, memberships
  // deactivated, event recorded and, unless the account is already gone,
  // the provider-side deletion queued for the worker.
  const deleteLocally = async (user, { correlationId, reason, deleteAccount }) => withTransaction(db, async (client) => {
    const deleted = await anonymizeUser(client, user.id);
    if (!deleted) return null;
    await deactivateMemberships(client, user.id);
    await enqueueEvent(client, {
      type: 'identity.user.deleted', key: user.id, data: { userId: user.id, reason }, correlationId,
    });
    if (deleteAccount) {
      await enqueueIdpTask(client, { action: 'delete-account', externalSubject: user.externalSubject });
    }
    return deleted;
  });

  // Brings one local user in line with the provider: copies the profile, or
  // anonymizes the user when the provider reports the account missing.
  // `account` may be passed when already fetched (null = confirmed missing).
  // The provider rejects duplicate emails, so a local user still holding `email` is stale:
  // reconcile that holder (without nested repair, so swapped emails cannot loop), then retry fn once
  const withEmailRepair = async (email, sub, correlationId, fn) => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof EmailTakenError)) throw err;
    }
    const holder = await findActiveByEmail(db, email);
    if (holder && holder.externalSubject !== sub) await reconcileUser(holder, { correlationId, repair: false });
    return fn();
  };

  const reconcileUser = async (user, { correlationId, account, repair = true } = {}) => {
    if (account === undefined) account = await idp.getAccount(user.externalSubject);
    if (!account) {
      logger.warn({ userId: user.id }, 'account missing at the identity provider; anonymizing user');
      await deleteLocally(user, { correlationId, reason: 'account-removed', deleteAccount: false });
      return 'deleted';
    }
    if (!profileDiffers(user, account)) return 'unchanged';
    // Only if nobody changed the row since it was read, so an admin edit is never overwritten
    const write = () => withTransaction(db, async (client) => {
      if (!await updateProfile(client, user.id, account, { seenAt: user.updatedAt })) return 'unchanged';
      await profileUpdated(client, user.id, correlationId);
      return 'updated';
    });
    return repair ? withEmailRepair(account.email, user.externalSubject, correlationId, write) : write();
  };

  return {
    // Sign-in sync from the verified claims. An email held by another local
    // user means that user's account changed or vanished at the provider
    // (for example deleted in the Keycloak console): repair it, then retry once.
    // Only a verified email may trigger that repair; an unverified one simply
    // conflicts until reconciliation has cleaned up.
    async signIn(claims, { correlationId } = {}) {
      // Publishes an event only when the claims actually changed the stored profile
      const upsert = () => withTransaction(db, async (client) => {
        const { updated, ...user } = await upsertUser(client, claims);
        if (updated) await profileUpdated(client, user.id, correlationId);
        return user;
      });
      return (claims.emailVerified ? withEmailRepair(claims.email, claims.sub, correlationId, upsert) : upsert())
        .catch(mapEmailTaken);
    },

    list: (query) => listUsers(db, query),

    bySubject: (sub) => findBySubject(db, sub),

    async get(id) {
      const user = await findById(db, id);
      if (!user) throw new NotFoundError('User not found');
      return user;
    },

    // The provider owns the login email and rejects duplicates, so it is
    // updated first; the sign-in sync and reconciliation repair a failed second step.
    async update(id, changes, { correlationId } = {}) {
      const user = await this.get(id);
      if (user.status !== 'active') throw new ConflictError('A deleted user cannot be changed');
      // Unchanged fields come from the provider, which may hold newer console edits
      const account = await idp.updateAccount(user.externalSubject, changes).catch(async (err) => {
        if (err instanceof IdpConflictError) throw emailTaken();
        if (err instanceof IdpNoEmailError) throw new ConflictError('The account has no email; include one in the change');
        if (err instanceof IdpNotFoundError) {
          await reconcileUser(user, { correlationId });
          throw new NotFoundError('The account no longer exists');
        }
        throw err;
      });
      return withEmailRepair(account.email, user.externalSubject, correlationId, () => withTransaction(db, async (client) => {
        const row = await updateProfile(client, id, account);
        // Deleted while the provider call was running: roll back, no event
        if (!row) throw new ConflictError('The user was deleted meanwhile');
        await profileUpdated(client, id, correlationId);
        return row;
      })).catch(mapEmailTaken);
    },

    async remove(id, { actorId, correlationId } = {}) {
      const user = await this.get(id);
      // Compared on the stored, canonical ID, so another spelling of your own ID is caught too
      if (user.id === actorId) throw new ForbiddenError('You cannot delete your own account');
      if (user.status === 'deleted') return;
      await deleteLocally(user, { correlationId, reason: 'deleted-by-admin', deleteAccount: true });
      logger.info({ userId: id, actorId }, 'user deleted');
    },

    reconcileUser,
  };
};
