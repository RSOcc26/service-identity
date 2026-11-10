import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';
import { UserDeletedError } from '../../src/data/users.js';

const user = { id: '0192f8e0-0000-7000-8000-000000000000', email: 'ana@test.local', displayName: 'Ana', locale: 'sl' };
const contexts = {
  valid: { idp_sub: 'kc-1', email: user.email, email_verified: true, name: 'Ana', given_name: 'Ana', family_name: 'Novak', idp_iat: 1793700000, rid: 'r1' },
  admin: { idp_sub: 'kc-1', email: user.email, name: 'Ana', roles: ['platform-admin'] },
  deleted: { idp_sub: 'kc-gone', email: 'gone@test.local' },
  noEmail: { idp_sub: 'kc-1' },
};
const verifyToken = async (token) => {
  if (!contexts[token]) throw new Error('invalid');
  return contexts[token];
};
const calls = [];
const users = {
  signIn: async (claims, ctx) => {
    calls.push({ claims, ctx });
    if (claims.sub === 'kc-gone') throw new UserDeletedError('deleted');
    return { ...user, status: 'active', externalSubject: claims.sub };
  },
};
const app = buildApp({ db: {}, verifyToken, users });
const get = (token) => app.inject({ url: '/v1/me', headers: token ? { authorization: `Bearer ${token}` } : {} });

test('GET /v1/me without a token returns 401 problem', async () => {
  const res = await get();
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'], /application\/problem\+json/);
});

test('GET /v1/me with an invalid token returns 401', async () => {
  assert.equal((await get('forged')).statusCode, 401);
});

test('GET /v1/me syncs the profile from the context and returns the user', async () => {
  const res = await get('valid');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ...user, platformRoles: [] });
  const { claims, ctx } = calls.at(-1);
  assert.deepEqual(claims, {
    sub: 'kc-1', email: user.email, name: 'Ana', givenName: 'Ana', familyName: 'Novak', emailVerified: true, issuedAt: 1793700000,
  });
  assert.equal(ctx.correlationId, 'r1');
});

test('GET /v1/me returns the platform roles from the context', async () => {
  assert.deepEqual((await get('admin')).json().platformRoles, ['platform-admin']);
});

test('GET /v1/me for a deleted account returns 403', async () => {
  assert.equal((await get('deleted')).statusCode, 403);
});

test('GET /v1/me without an email claim returns 401', async () => {
  assert.equal((await get('noEmail')).statusCode, 401);
});

test('malformed JSON and other client errors keep their 4xx status', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/v1/admin/users/0192f8e0-0000-7000-8000-000000000001',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, payload: '{"email":',
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.headers['content-type'], /application\/problem\+json/);
});
