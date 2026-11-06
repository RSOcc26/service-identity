import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';
import { NotFoundError, ConflictError, ForbiddenError } from '../../src/domain/users.js';
import { IdpUnavailableError } from '../../src/idp/keycloak.js';

const ID = '0192f8e0-0000-7000-8000-000000000001';
const ADMIN_ID = '0192f8e0-0000-7000-8000-0000000000aa';
const row = { id: ID, status: 'active', email: 'ana@test.local', displayName: 'Ana Novak', givenName: 'Ana', familyName: 'Novak', locale: 'sl', externalSubject: 'kc-1' };

const contexts = {
  admin: { sub: ADMIN_ID, idp_sub: 'kc-admin', roles: ['platform-admin'], rid: 'r1' },
  member: { sub: 'u2', idp_sub: 'kc-2', roles: [] },
  gateway: { svc: 'gateway', rid: 'r2' },
};
const verifyToken = async (token) => {
  if (!contexts[token]) throw new Error('invalid');
  return contexts[token];
};

const calls = [];
let behaviour = {};
const users = {
  list: async (q) => { calls.push(['list', q]); return { items: [row], total: 1 }; },
  get: async (id) => { if (id !== ID) throw new NotFoundError('User not found'); return row; },
  update: async (id, changes, ctx) => {
    calls.push(['update', id, changes, ctx]);
    if (behaviour.update) throw behaviour.update;
    return { ...row, ...changes };
  },
  remove: async (id, ctx) => {
    calls.push(['remove', id, ctx]);
    if (id === ctx.actorId) throw new ForbiddenError('You cannot delete your own account');
  },
  bySubject: async (sub) => (sub === 'kc-1' ? row : null),
};
const app = buildApp({ db: {}, verifyToken, users });
const call = (method, url, token, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

test('admin routes require the platform-admin role', async () => {
  for (const [method, url] of [['GET', '/v1/admin/users'], ['GET', `/v1/admin/users/${ID}`], ['DELETE', `/v1/admin/users/${ID}`]]) {
    assert.equal((await call(method, url, 'member')).statusCode, 403);
    assert.equal((await call(method, url, 'gateway')).statusCode, 403);
  }
});

test('GET /v1/admin/users lists users without internal fields and applies defaults', async () => {
  const res = await call('GET', '/v1/admin/users?search=ana', 'admin');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().total, 1);
  assert.equal(res.json().items[0].externalSubject, undefined);
  const [name, query] = calls.at(-1);
  assert.equal(name, 'list');
  assert.deepEqual({ ...query }, { search: 'ana', status: 'active', limit: 25, offset: 0 });
});

test('GET /v1/admin/users rejects invalid query values', async () => {
  assert.equal((await call('GET', '/v1/admin/users?limit=1000', 'admin')).statusCode, 400);
  assert.equal((await call('GET', '/v1/admin/users?status=weird', 'admin')).statusCode, 400);
});

test('GET /v1/admin/users/:id returns 404 for an unknown user and 400 for a bad ID', async () => {
  assert.equal((await call('GET', `/v1/admin/users/${ID}`, 'admin')).statusCode, 200);
  assert.equal((await call('GET', '/v1/admin/users/0192f8e0-0000-7000-8000-00000000ffff', 'admin')).statusCode, 404);
  assert.equal((await call('GET', '/v1/admin/users/not-a-uuid', 'admin')).statusCode, 400);
});

test('PATCH /v1/admin/users/:id updates allowed fields with the actor and correlation ID', async () => {
  const res = await call('PATCH', `/v1/admin/users/${ID}`, 'admin', { email: 'ana.n@test.local', givenName: 'Ana' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().email, 'ana.n@test.local');
  assert.deepEqual(calls.at(-1), ['update', ID, { email: 'ana.n@test.local', givenName: 'Ana' }, { correlationId: 'r1', actorId: ADMIN_ID }]);
});

test('PATCH /v1/admin/users/:id validates the body', async () => {
  assert.equal((await call('PATCH', `/v1/admin/users/${ID}`, 'admin', { email: 'not-an-email' })).statusCode, 400);
  assert.equal((await call('PATCH', `/v1/admin/users/${ID}`, 'admin', { givenName: '   ' })).statusCode, 400);
  assert.equal((await call('PATCH', `/v1/admin/users/${ID}`, 'admin', { status: 'deleted' })).statusCode, 400);
  assert.equal((await call('PATCH', `/v1/admin/users/${ID}`, 'admin', {})).statusCode, 400);
});

test('PATCH maps a taken email to 409 and an unreachable provider to 503', async () => {
  behaviour.update = new ConflictError('This email belongs to another account');
  assert.equal((await call('PATCH', `/v1/admin/users/${ID}`, 'admin', { email: 'b@test.local' })).statusCode, 409);
  behaviour.update = new IdpUnavailableError('down');
  assert.equal((await call('PATCH', `/v1/admin/users/${ID}`, 'admin', { email: 'b@test.local' })).statusCode, 503);
  behaviour = {};
});

test('DELETE /v1/admin/users/:id returns 204; deleting yourself returns 403', async () => {
  assert.equal((await call('DELETE', `/v1/admin/users/${ID}`, 'admin')).statusCode, 204);
  assert.deepEqual(calls.at(-1), ['remove', ID, { correlationId: 'r1', actorId: ADMIN_ID }]);
  assert.equal((await call('DELETE', `/v1/admin/users/${ADMIN_ID}`, 'admin')).statusCode, 403);
});

test('the internal subject lookup is only for the gateway', async () => {
  const res = await call('GET', '/v1/internal/users/by-subject/kc-1', 'gateway');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id: ID, status: 'active' });
  assert.equal((await call('GET', '/v1/internal/users/by-subject/kc-x', 'gateway')).statusCode, 404);
  assert.equal((await call('GET', '/v1/internal/users/by-subject/kc-1', 'admin')).statusCode, 403);
});
