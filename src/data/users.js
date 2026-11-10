import { setContext } from './tx.js';

export class EmailTakenError extends Error {}
export class UserDeletedError extends Error {}

const COLUMNS = `id, status, email, display_name AS "displayName", given_name AS "givenName",
  family_name AS "familyName", locale, external_subject AS "externalSubject",
  created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"`;

const isEmailConflict = (err) => err.code === '23505' && err.constraint === 'users_email_key';

const displayName = ({ name, givenName, familyName, email }) =>
  name || [givenName, familyName].filter(Boolean).join(' ') || email;

// Creates the user on first sight of a token subject and keeps the profile in
// sync. A deleted user is never revived, and claims from a token issued
// before the user's last change (for example an admin edit) never overwrite it.
export const upsertUser = async (db, { sub, email, name, givenName, familyName, issuedAt }) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO users (external_subject, email, display_name, given_name, family_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (external_subject) DO UPDATE SET email = EXCLUDED.email,
         display_name = EXCLUDED.display_name, given_name = EXCLUDED.given_name,
         family_name = EXCLUDED.family_name, updated_at = now()
       WHERE users.status = 'active' AND ($6::timestamptz IS NULL OR users.updated_at <= $6::timestamptz)
         AND (users.email, users.display_name, users.given_name, users.family_name)
           IS DISTINCT FROM (EXCLUDED.email, EXCLUDED.display_name, EXCLUDED.given_name, EXCLUDED.family_name)
       RETURNING ${COLUMNS}, xmax <> 0 AS updated`,
      [sub, email, displayName({ name, givenName, familyName, email }), givenName ?? null, familyName ?? null,
        issuedAt ? new Date(issuedAt * 1000).toISOString() : null],
    );
    if (rows[0]) return rows[0];
    // Not updated: either deleted, or the stored profile is newer than the token
    const current = await findBySubject(db, sub);
    if (!current || current.status !== 'active') throw new UserDeletedError('The account was deleted');
    return current;
  } catch (err) {
    if (isEmailConflict(err)) throw new EmailTakenError('Another user has this email');
    throw err;
  }
};

export const findById = async (db, id) =>
  (await db.query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id])).rows[0] ?? null;

export const findBySubject = async (db, sub) =>
  (await db.query(`SELECT ${COLUMNS} FROM users WHERE external_subject = $1`, [sub])).rows[0] ?? null;

export const findActiveByEmail = async (db, email) =>
  (await db.query(`SELECT ${COLUMNS} FROM users WHERE lower(email) = lower($1) AND status = 'active'`, [email])).rows[0] ?? null;

export const listActiveUsers = async (db) =>
  (await db.query(`SELECT ${COLUMNS} FROM users WHERE status = 'active'`)).rows;

// Page of users for administration; search matches email or name
export const listUsers = async (db, { search, status, limit, offset }) => {
  const params = [];
  const where = [];
  if (status !== 'all') {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(email ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const n = params.length;
  const [count, page] = await Promise.all([
    db.query(`SELECT count(*) FROM users ${filter}`, params),
    db.query(
      `SELECT ${COLUMNS} FROM users ${filter}
       ORDER BY display_name NULLS LAST, created_at LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, limit, offset],
    ),
  ]);
  return { items: page.rows, total: Number(count.rows[0].count) };
};

// Applies profile values coming from the identity provider
// seenAt: update only if the row was not changed after that time (millisecond precision, as in JS)
export const updateProfile = async (db, id, { email, givenName, familyName }, { seenAt = null } = {}) => {
  try {
    const { rows } = await db.query(
      `UPDATE users SET email = $2, given_name = $3, family_name = $4, display_name = $5, updated_at = now()
       WHERE id = $1 AND status = 'active'
         AND ($6::timestamptz IS NULL OR date_trunc('milliseconds', updated_at) <= $6::timestamptz)
       RETURNING ${COLUMNS}`,
      [id, email, givenName ?? null, familyName ?? null, displayName({ givenName, familyName, email }), seenAt],
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isEmailConflict(err)) throw new EmailTakenError('Another user has this email');
    throw err;
  }
};

// Erases personal data and marks the user deleted; returns null if it was not active
export const anonymizeUser = async (client, id) => (await client.query(
  `UPDATE users SET status = 'deleted', email = NULL, display_name = NULL, given_name = NULL,
     family_name = NULL, deleted_at = now(), updated_at = now()
   WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`,
  [id],
)).rows[0] ?? null;

// Deactivates the user's memberships in every company. RLS allows the runtime
// role one tenant at a time, so each membership is changed in its own tenant
// context instead of bypassing row-level security.
export const deactivateMemberships = async (client, userId) => {
  await setContext(client, { userId });
  const { rows } = await client.query(
    "SELECT tenant_id FROM memberships WHERE user_id = $1 AND status = 'active'",
    [userId],
  );
  for (const { tenant_id: tenantId } of rows) {
    await setContext(client, { tenantId, userId });
    await client.query(
      "UPDATE memberships SET status = 'inactive', updated_at = now() WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId],
    );
  }
  await setContext(client, {});
  return rows.length;
};

// Public representation (no internal subject)
export const toUser = ({ externalSubject, ...user }) => user;
