import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { fileURLToPath } from 'node:url';
import { register, collectDefaultMetrics } from 'prom-client';
import { v1 } from './api/v1.js';

// Process metrics
collectDefaultMetrics();

// Builds the Fastify app
export const buildApp = ({ db, verifyToken, ...opts } = {}) => {
  const app = Fastify(opts);

  // Serves the contract-first OpenAPI document from src/api/
  app.register(swagger, {
    mode: 'static',
    specification: { path: fileURLToPath(new URL('./api/openapi.yaml', import.meta.url)) },
  });
  app.get('/api-docs', async (req, reply) =>
    req.headers.accept?.includes('yaml')
      ? reply.type('application/yaml').send(app.swagger({ yaml: true }))
      : app.swagger());

  app.get('/health/live', async () => ({ status: 'ok' }));
  // Ready when the database answers
  app.get('/health/ready', async (req, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok', checks: { database: { status: 'ok' } } };
    } catch (err) {
      return reply.code(503).send({ status: 'fail', checks: { database: { status: 'fail', detail: err.message } } });
    }
  });
  app.get('/metrics', async (req, reply) => reply.type(register.contentType).send(await register.metrics()));
  app.register(v1, { prefix: '/v1', db, verifyToken });
  return app;
};
