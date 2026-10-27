import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';

for (const path of ['/health/live', '/health/ready']) {
  test(`GET ${path} returns ok`, async () => {
    const res = await buildApp().inject(path);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });
}
