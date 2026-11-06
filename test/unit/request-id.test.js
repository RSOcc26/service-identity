import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';

const app = buildApp({ db: { query: async () => {} }, verifyToken: async () => { throw new Error('invalid'); }, users: {} });

test('the gateway X-Request-Id is used as the request ID and returned', async () => {
  const res = await app.inject({ url: '/health/live', headers: { 'x-request-id': 'req-abc.1' } });
  assert.equal(res.headers['x-request-id'], 'req-abc.1');
});

test('an unsafe or missing X-Request-Id is replaced by a generated one', async () => {
  for (const headers of [{}, { 'x-request-id': 'bad id\n' }, { 'x-request-id': 'x'.repeat(65) }]) {
    const res = await app.inject({ url: '/health/live', headers });
    assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  }
});

test('problem documents carry the correlation ID', async () => {
  const res = await app.inject({ url: '/v1/me', headers: { 'x-request-id': 'req-401' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().correlationId, 'req-401');
});

test('unknown paths return a problem document, not Fastify\'s default body', async () => {
  for (const url of ['/v1/nope', '/nope']) {
    const res = await app.inject({ url, headers: { 'x-request-id': 'req-404' } });
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/problem\+json/);
    assert.equal(res.json().correlationId, 'req-404');
  }
});
