// Runs fn inside one transaction on a dedicated client; rolls back on error
export const withTransaction = async (db, fn) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// Runs fn(lockClient) only if this replica gets the named advisory lock; else returns `busy`
export const withAdvisoryLock = async (db, key, fn, busy) => {
  const lock = await db.connect();
  try {
    const { rows: [{ locked }] } = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    if (!locked) return busy;
    try {
      return await fn(lock);
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    }
  } finally {
    lock.release();
  }
};

// Sets the per-transaction request context read by the RLS policies
export const setContext = (client, { tenantId, userId }) => client.query(
  "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
  [tenantId ?? '', userId ?? ''],
);
