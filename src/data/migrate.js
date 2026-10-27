import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';

// Applies pending migrations as the migration role (DATABASE_MIGRATION_URL)
export const migrate = (logger) => runner({
  databaseUrl: process.env.DATABASE_MIGRATION_URL,
  dir: fileURLToPath(new URL('../../migrations', import.meta.url)),
  direction: 'up',
  migrationsTable: 'pgmigrations',
  logger,
});
