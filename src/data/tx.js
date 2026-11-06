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

// Sets the per-transaction request context read by the RLS policies
export const setContext = (client, { tenantId, userId }) => client.query(
  "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
  [tenantId ?? '', userId ?? ''],
);
