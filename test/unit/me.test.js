import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';

const user = { id: '0192f8e0-0000-7000-8000-000000000000', email: 'ana@test.local', displayName: 'Ana', locale: 'sl' };
const db = { query: async () => ({ rows: [user] }) };
const verifyToken = async (token) => {
  if (token !== 'valid') throw new Error('invalid');
  return { sub: 'kc-1', email: user.email, name: user.displayName };
};
const app = buildApp({ db, verifyToken });

test('GET /v1/me without a token returns 401 problem', async () => {
  const res = await app.inject('/v1/me');
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'], /application\/problem\+json/);
});

test('GET /v1/me with an invalid token returns 401', async () => {
  const res = await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer forged' } });
  assert.equal(res.statusCode, 401);
});

test('GET /v1/me with a valid token returns the user', async () => {
  const res = await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer valid' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), user);
});
