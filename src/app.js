import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { fileURLToPath } from 'node:url';
import { register, collectDefaultMetrics } from 'prom-client';
import { v1 } from './api/v1.js';
import { genRequestId, sendProblem } from './api/problem.js';

// Process metrics
collectDefaultMetrics();

// Builds the Fastify app
// `users` is the account service (src/domain/users.js), or a function that
// builds it from the app's logger
export const buildApp = ({ db, verifyToken, users, ...opts } = {}) => {
  // Unknown fields are rejected, not silently dropped
  // The request ID comes from the gateway's X-Request-Id, so logs correlate
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } }, genReqId: genRequestId, ...opts });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.setNotFoundHandler((req, reply) => sendProblem(reply, 404, 'Not Found'));
  const userService = typeof users === 'function' ? users(app.log) : users;
  app.decorate('users', userService);

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
  app.register(v1, { prefix: '/v1', verifyToken, users: userService });
  return app;
};
