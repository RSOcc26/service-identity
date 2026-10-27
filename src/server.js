import { buildApp } from './app.js';
import { createPool } from './data/db.js';
import { migrate } from './data/migrate.js';
import { createVerifier } from './api/auth.js';

const app = buildApp({
  db: createPool(),
  verifyToken: createVerifier({ issuer: process.env.OIDC_ISSUER, jwksUrl: process.env.OIDC_JWKS_URL }),
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

await migrate(app.log);
await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' });
