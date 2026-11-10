import { buildApp } from './app.js';
import { createPool } from './data/db.js';
import { migrate } from './data/migrate.js';
import { createVerifier } from './api/auth.js';
import { createKeycloakAdmin } from './idp/keycloak.js';
import { createUserService } from './domain/users.js';
import { createKafkaPublisher, relayOutbox } from './events/relay.js';
import { runIdpTasks } from './jobs/idp-tasks.js';
import { reconcile } from './jobs/reconcile.js';
import { every } from './jobs/scheduler.js';

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`${name} is required`);
  return env[name];
};
// Fails at startup, so a typo like "5m" never becomes NaN (a ~1 ms job interval, or no deletion cap)
const number = (name, fallback, min) => {
  const value = Number(env[name] || fallback);
  if (!(value >= min)) throw new Error(`${name} must be a number >= ${min}`);
  return value;
};
const seconds = (name, fallback) => number(name, fallback, 1) * 1000;

const db = createPool();
const idp = createKeycloakAdmin({
  adminUrl: required('IDP_ADMIN_URL'),
  tokenUrl: required('IDP_TOKEN_URL'),
  clientId: required('IDP_CLIENT_ID'),
  clientSecret: required('IDP_CLIENT_SECRET'),
});

const app = buildApp({
  db,
  verifyToken: createVerifier({
    jwksUrl: required('TENANT_CONTEXT_JWKS_URL'),
    issuer: required('TENANT_CONTEXT_ISSUER'),
    audience: required('TENANT_CONTEXT_AUDIENCE'),
  }),
  logger: { level: env.LOG_LEVEL ?? 'info' },
  users: (logger) => createUserService({ db, idp, logger }),
});
const { users } = app;

const publisher = createKafkaPublisher({
  brokers: required('KAFKA_BROKERS').split(','),
  clientId: env.KAFKA_CLIENT_ID || 'service-identity',
  saslMechanism: env.KAFKA_SASL_MECHANISM || undefined,
  username: env.KAFKA_USERNAME,
  password: env.KAFKA_PASSWORD,
});

await migrate(app.log);
await app.listen({ port: Number(env.PORT ?? 3001), host: '0.0.0.0' });

// Background work (ADR-0003); each job is safe to run on several replicas
const jobs = [
  every('outbox-relay', seconds('OUTBOX_RELAY_INTERVAL_SECONDS', 2), () => relayOutbox({ db, publisher }), app.log),
  every('idp-tasks', seconds('IDP_TASK_INTERVAL_SECONDS', 5), () => runIdpTasks({ db, idp, logger: app.log }), app.log),
  every('reconcile', seconds('RECONCILE_INTERVAL_SECONDS', 300), () => reconcile({
    db, idp, users, logger: app.log, maxDeletions: number('RECONCILE_MAX_DELETIONS', 25, 0),
  }), app.log),
];
jobs.forEach((job) => job.runNow());

const shutdown = async () => {
  jobs.forEach((job) => job.stop());
  await app.close();
  await publisher.close();
  await db.end();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
