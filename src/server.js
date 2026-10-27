import { buildApp } from './app.js';
import { createPool } from './data/db.js';
import { migrate } from './data/migrate.js';

const app = buildApp({ db: createPool(), logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await migrate(app.log);
await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' });
