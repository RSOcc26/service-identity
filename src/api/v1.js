import { upsertUser } from '../data/users.js';

// Version 1 API routes; every route requires a valid bearer token
export const v1 = async (app, { db, verifyToken }) => {
  app.addHook('onRequest', async (req, reply) => {
    try {
      req.claims = await verifyToken(req.headers.authorization?.replace(/^Bearer /, ''));
    } catch {
      return reply.code(401).type('application/problem+json')
        .send({ type: 'about:blank', title: 'Unauthorized', status: 401 });
    }
  });

  app.get('/me', async (req) => upsertUser(db, req.claims));
};
