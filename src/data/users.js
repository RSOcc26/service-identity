// Creates the user on first sight of a token subject, keeps email and name in sync
export const upsertUser = async (db, { sub, email, name }) => (await db.query(
  `INSERT INTO users (external_subject, email, display_name) VALUES ($1, $2, $3)
  ON CONFLICT (external_subject) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
  RETURNING id, email, display_name AS "displayName", locale`,
  [sub, email, name ?? email],
)).rows[0];
