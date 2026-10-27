import { buildApp } from './app.js';

const app = buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' });
