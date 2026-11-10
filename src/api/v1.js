import { toUser, UserDeletedError } from '../data/users.js';
import { NotFoundError, ConflictError, ForbiddenError, PLATFORM_ADMIN } from '../domain/users.js';
import { IdpUnavailableError } from '../idp/keycloak.js';
import { sendProblem as problem } from './problem.js';

// The pattern rejects the urn:uuid: form that the uuid format allows but PostgreSQL does not
const userId = { type: 'string', format: 'uuid', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' };
const name = { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' };

// Version 1 API routes; every route requires the gateway's tenant context
export const v1 = async (app, { verifyToken, users }) => {
  app.addHook('onRequest', async (req, reply) => {
    try {
      req.claims = await verifyToken(req.headers.authorization?.replace(/^Bearer /, ''));
    } catch {
      return problem(reply, 401, 'Unauthorized');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return problem(reply, 400, 'Bad Request', err.message);
    if (err instanceof NotFoundError) return problem(reply, 404, 'Not Found', err.message);
    if (err instanceof ConflictError) return problem(reply, 409, 'Conflict', err.message);
    if (err instanceof ForbiddenError) return problem(reply, 403, 'Forbidden', err.message);
    if (err instanceof UserDeletedError) return problem(reply, 403, 'Forbidden', 'This account was deleted.');
    if (err instanceof IdpUnavailableError) {
      req.log.error({ err }, 'identity provider unavailable');
      return problem(reply, 503, 'Service Unavailable', 'Account changes are temporarily unavailable.');
    }
    // Fastify's own client errors (malformed JSON, wrong content type, too large)
    if (err.statusCode >= 400 && err.statusCode < 500) return problem(reply, err.statusCode, 'Bad Request', err.message);
    req.log.error({ err }, 'unhandled error');
    return problem(reply, 500, 'Internal Server Error');
  });

  const ctx = (req) => ({ correlationId: req.claims.rid, actorId: req.claims.sub });

  // The signed-in user, created on first sign-in from the provider's claims
  app.get('/me', async (req, reply) => {
    if (!req.claims.idp_sub || !req.claims.email) return problem(reply, 401, 'Unauthorized');
    const user = await users.signIn({
      sub: req.claims.idp_sub,
      email: req.claims.email,
      name: req.claims.name,
      givenName: req.claims.given_name,
      familyName: req.claims.family_name,
      emailVerified: req.claims.email_verified === true,
      issuedAt: req.claims.idp_iat,
    }, ctx(req));
    const { id, email, displayName, locale } = user;
    return { id, email, displayName, locale, platformRoles: req.claims.roles ?? [] };
  });

  // Platform administration (ADR-0003): only for the platform-admin role
  app.register(async (admin) => {
    admin.addHook('preHandler', async (req, reply) => {
      // sub is needed to know who acts (audit, no self-delete)
      if (!req.claims.sub || !req.claims.roles?.includes(PLATFORM_ADMIN)) return problem(reply, 403, 'Forbidden');
    });

    admin.get('/users', {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            search: { type: 'string', maxLength: 100 },
            status: { enum: ['active', 'deleted', 'all'], default: 'active' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    }, async (req) => {
      const { items, total } = await users.list(req.query);
      return { items: items.map(toUser), total };
    });

    admin.get('/users/:id', { schema: { params: { type: 'object', properties: { id: userId } } } },
      async (req) => toUser(await users.get(req.params.id)));

    admin.patch('/users/:id', {
      schema: {
        params: { type: 'object', properties: { id: userId } },
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { email: { type: 'string', format: 'email', maxLength: 254 }, givenName: name, familyName: name },
        },
      },
    }, async (req) => toUser(await users.update(req.params.id, req.body, ctx(req))));

    admin.delete('/users/:id', { schema: { params: { type: 'object', properties: { id: userId } } } },
      async (req, reply) => {
        await users.remove(req.params.id, ctx(req));
        return reply.code(204).send();
      });
  }, { prefix: '/admin' });

  // Gateway-only: resolves a provider subject to the CompanyCentral user
  app.get('/internal/users/by-subject/:sub', async (req, reply) => {
    if (req.claims.svc !== 'gateway') return problem(reply, 403, 'Forbidden');
    const user = await users.bySubject(req.params.sub);
    if (!user) return problem(reply, 404, 'Not Found');
    return { id: user.id, status: user.status };
  });
};
