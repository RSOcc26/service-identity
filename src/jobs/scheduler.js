// Runs a job every intervalMs without overlapping runs; errors are logged,
// never thrown, so one failing dependency does not stop the service.
export const every = (name, intervalMs, job, logger) => {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      logger.warn({ job: name, err: err.message }, 'background job failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), runNow: tick };
};
