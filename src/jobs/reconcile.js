// Reconciles identity users with the identity provider (ADR-0003): catches
// accounts deleted or edited outside CompanyCentral, for example in the
// Keycloak admin console.
//
// Safety: a user is anonymized only when the provider answers 404 for that
// specific account (an empty or failed listing never deletes anything). A run
// deletes nothing when it would delete more than `maxDeletions` users, every
// user, or more than half of them (with at least 4 users): all signs of a
// misconfigured provider (for example the wrong realm) rather than real deletions.

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

export const reconcile = async ({ db, idp, users, logger, maxDeletions = 25 }) => {
  // Only one replica reconciles at a time
  const lock = await db.connect();
  try {
    const { rows: [{ locked }] } = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_KEY]);
    if (!locked) return { skipped: true };
    try {
      const accounts = await listAllAccounts(idp);
      const { rows: active } = await db.query(
        `SELECT id, email, given_name AS "givenName", family_name AS "familyName",
           external_subject AS "externalSubject" FROM users WHERE status = 'active'`,
      );

      const changed = active.filter((u) => {
        const a = accounts.get(u.externalSubject);
        return a && a.email && (a.email !== u.email || a.givenName !== u.givenName || a.familyName !== u.familyName);
      });
      // Not in the listing: confirm each one individually before treating it as gone
      const unlisted = active.filter((u) => !accounts.has(u.externalSubject));
      const missing = [];
      for (const u of unlisted) {
        if (await idp.getAccount(u.externalSubject) === null) missing.push(u);
      }
      if (isSuspicious(missing.length, active.length, maxDeletions)) {
        logger.error({ missing: missing.length, active: active.length, maxDeletions },
          'reconciliation would delete too many users; nothing deleted, check the identity provider configuration');
        return { skipped: true, missing: missing.length };
      }

      const result = { updated: 0, deleted: 0, failed: 0 };
      for (const u of [...missing, ...changed]) {
        try {
          const outcome = await users.reconcileUser(u, { correlationId: 'reconciliation' });
          if (outcome === 'deleted') result.deleted += 1;
          if (outcome === 'updated') result.updated += 1;
        } catch (err) {
          result.failed += 1;
          logger.warn({ userId: u.id, err: err.message }, 'reconciling user failed');
        }
      }
      if (result.updated || result.deleted || result.failed) logger.info(result, 'reconciliation finished');
      return result;
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    }
  } finally {
    lock.release();
  }
};
