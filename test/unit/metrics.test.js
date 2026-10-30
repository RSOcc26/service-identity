import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';

test('GET /metrics returns Prometheus text', async () => {
  const res = await buildApp().inject('/metrics');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.body, /process_cpu_user_seconds_total/);
});
