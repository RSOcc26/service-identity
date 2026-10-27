import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';

test('GET /api-docs returns the OpenAPI document as JSON', async () => {
  const res = await buildApp().inject('/api-docs');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().openapi, '3.1.0');
});

test('GET /api-docs returns YAML when asked', async () => {
  const res = await buildApp().inject({ url: '/api-docs', headers: { accept: 'application/yaml' } });
  assert.match(res.headers['content-type'], /application\/yaml/);
  assert.match(res.body, /^openapi: 3\.1\.0/);
});
