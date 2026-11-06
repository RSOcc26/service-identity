import { withTransaction } from '../data/tx.js';
import {
  upsertUser, findById, findBySubject, findActiveByEmail, listUsers, updateProfile, anonymizeUser,
  deactivateMemberships, EmailTakenError,
} from '../data/users.js';
import { enqueueEvent, enqueueIdpTask } from '../data/outbox.js';
import { IdpConflictError, IdpNotFoundError } from '../idp/keycloak.js';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ForbiddenError extends Error {}

export const PLATFORM_ADMIN = 'platform-admin';

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
  const reconcileUser = async (user, { correlationId } = {}) => {
    const account = await idp.getAccount(user.externalSubject);
    if (!account) {
      logger.warn({ userId: user.id }, 'account missing at the identity provider; anonymizing user');
      await deleteLocally(user, { correlationId, reason: 'account-removed', deleteAccount: false });
      return 'deleted';
    }
    if (account.email && (account.email !== user.email
      || account.givenName !== user.givenName || account.familyName !== user.familyName)) {
      await updateProfile(db, user.id, account);
      return 'updated';
    }
    return 'unchanged';
  };

  return {
    // Sign-in sync from the verified claims. An email held by another local
    // user means that user's account changed or vanished at the provider
    // (for example deleted in the Keycloak console): repair it, then retry once.
    // Only a verified email may trigger that repair; an unverified one simply
    // conflicts until reconciliation has cleaned up.
    async signIn(claims, { correlationId } = {}) {
      const taken = () => new ConflictError('This email belongs to another account');
      try {
        return await upsertUser(db, claims);
      } catch (err) {
        if (!(err instanceof EmailTakenError)) throw err;
        if (!claims.emailVerified) throw taken();
        try {
          const holder = await findActiveByEmail(db, claims.email);
          if (holder && holder.externalSubject !== claims.sub) await reconcileUser(holder, { correlationId });
          return await upsertUser(db, claims);
        } catch (retryErr) {
          if (retryErr instanceof EmailTakenError) throw taken();
          throw retryErr;
        }
      }
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
      const next = {
        email: changes.email ?? user.email,
        givenName: changes.givenName ?? user.givenName,
        familyName: changes.familyName ?? user.familyName,
      };
      try {
        await idp.updateAccount(user.externalSubject, next);
      } catch (err) {
        if (err instanceof IdpConflictError) throw new ConflictError('This email belongs to another account');
        if (err instanceof IdpNotFoundError) {
          await reconcileUser(user, { correlationId });
          throw new NotFoundError('The account no longer exists');
        }
        throw err;
      }
      const updated = await withTransaction(db, async (client) => {
        const row = await updateProfile(client, id, next);
        // Deleted while the provider call was running: roll back, no event
        if (!row) throw new ConflictError('The user was deleted meanwhile');
        await enqueueEvent(client, { type: 'identity.user.updated', key: id, data: { userId: id }, correlationId });
        return row;
      }).catch((err) => {
        if (err instanceof EmailTakenError) throw new ConflictError('This email belongs to another account');
        throw err;
      });
      return updated;
    },

    async remove(id, { actorId, correlationId } = {}) {
      if (id === actorId) throw new ForbiddenError('You cannot delete your own account');
      const user = await this.get(id);
      if (user.status === 'deleted') return;
      await deleteLocally(user, { correlationId, reason: 'deleted-by-admin', deleteAccount: true });
      logger.info({ userId: id, actorId }, 'user deleted');
    },

    reconcileUser,
  };
};
