import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';

const up = { query: async () => {} };
const down = { query: async () => { throw new Error('connection refused'); } };

test('GET /health/live returns ok', async () => {
  const res = await buildApp().inject('/health/live');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('GET /health/ready returns ok when the database answers', async () => {
  const res = await buildApp({ db: up }).inject('/health/ready');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().checks.database.status, 'ok');
});

test('GET /health/ready returns 503 when the database is down', async () => {
  const res = await buildApp({ db: down }).inject('/health/ready');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().status, 'fail');
});
