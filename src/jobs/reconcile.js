// Reconciles identity users with the identity provider (ADR-0003): catches
// accounts deleted or edited outside CompanyCentral, for example in the
// Keycloak admin console.
//
// Safety: a user is anonymized only when the provider answers 404 for that
// specific account (an empty or failed listing never deletes anything). A run
// deletes nothing when it would delete more than `maxDeletions` users, every
// user, or more than half of them (with at least 4 users): all signs of a
// misconfigured provider (for example the wrong realm) rather than real deletions.
import { withAdvisoryLock } from '../data/tx.js';
import { listActiveUsers } from '../data/users.js';
import { profileDiffers } from '../domain/users.js';

const LOCK_KEY = 'service-identity.reconcile';
const PAGE = 500;

const listAllAccounts = async (idp) => {
  const accounts = new Map();
  for (let first = 0; ; first += PAGE) {
    const page = await idp.listAccounts({ first, max: PAGE });
    for (const a of page) accounts.set(a.sub, a);
    if (page.length < PAGE) return accounts;
  }
};

export const isSuspicious = (missing, active, maxDeletions) => missing > 0 && (
  missing > maxDeletions || missing === active || (active >= 4 && missing / active > 0.5));

// Only one replica reconciles at a time
export const reconcile = ({ db, idp, users, logger, maxDeletions = 25 }) => withAdvisoryLock(db, LOCK_KEY, async () => {
  const [accounts, active] = await Promise.all([listAllAccounts(idp), listActiveUsers(db)]);

  const changed = active.filter((u) => accounts.has(u.externalSubject) && profileDiffers(u, accounts.get(u.externalSubject)));
  // Not in the listing: confirm each one individually before treating it as gone
  const missing = [];
  for (const u of active.filter((u) => !accounts.has(u.externalSubject))) {
    if (await idp.getAccount(u.externalSubject) === null) missing.push(u);
  }
  if (isSuspicious(missing.length, active.length, maxDeletions)) {
    logger.error({ missing: missing.length, active: active.length, maxDeletions },
      'reconciliation would delete too many users; nothing deleted, check the identity provider configuration');
    return { skipped: true, missing: missing.length };
  }

  const result = { updated: 0, deleted: 0, failed: 0 };
  // The account is already known (null = confirmed missing), so it is not fetched again
  for (const u of [...missing, ...changed]) {
    try {
      const account = accounts.get(u.externalSubject) ?? null;
      const outcome = await users.reconcileUser(u, { correlationId: 'reconciliation', account });
      if (outcome === 'deleted') result.deleted += 1;
      if (outcome === 'updated') result.updated += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn({ userId: u.id, err: err.message }, 'reconciling user failed');
    }
  }
  if (result.updated || result.deleted || result.failed) logger.info(result, 'reconciliation finished');
  return result;
}, { skipped: true });
