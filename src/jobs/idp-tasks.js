const MAX_BACKOFF_MS = 10 * 60_000;
// A claimed task is invisible to other runners for this long
const LEASE_SECONDS = 120;
// After this many attempts (about 8 hours) a task is parked for an operator
export const MAX_ATTEMPTS = 50;

export const backoffMs = (attempts) => Math.min(5_000 * 2 ** attempts, MAX_BACKOFF_MS);

// Runs due identity-provider tasks (ADR-0003). Tasks are claimed with a short
// lease in one quick statement, so no transaction or row lock is held while
// calling the provider, and several replicas never run the same task. A
// runner that dies mid-task leaves it to be picked up again when the lease ends.
export const runIdpTasks = async ({ db, idp, logger, batchSize = 10 }) => {
  const { rows } = await db.query(
    `UPDATE idp_tasks SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
     WHERE id IN (
       SELECT id FROM idp_tasks WHERE done_at IS NULL AND next_attempt_at <= now()
       ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, action, external_subject, attempts`,
    [batchSize, LEASE_SECONDS],
  );
  for (const task of rows) {
    try {
      if (task.action === 'delete-account') await idp.deleteAccount(task.external_subject);
      await db.query('UPDATE idp_tasks SET done_at = now(), last_error = NULL WHERE id = $1', [task.id]);
    } catch (err) {
      const giveUp = task.attempts >= MAX_ATTEMPTS;
      logger[giveUp ? 'error' : 'warn']({ taskId: task.id, action: task.action, attempts: task.attempts, err: err.message },
        giveUp ? 'identity provider task keeps failing; parked, needs an operator' : 'identity provider task failed; will retry');
      await db.query(
        `UPDATE idp_tasks SET last_error = $2,
           next_attempt_at = CASE WHEN $4 THEN 'infinity'::timestamptz ELSE now() + make_interval(secs => $3) END
         WHERE id = $1`,
        [task.id, err.message.slice(0, 500), backoffMs(task.attempts - 1) / 1000, giveUp],
      );
    }
  }
  return rows.length;
};
