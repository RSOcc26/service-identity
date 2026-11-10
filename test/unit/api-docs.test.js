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

test('operations not implemented yet are marked planned, and implemented ones are not', async () => {
  const { buildApp: build } = await import('../../src/app.js');
  const app = build({ db: {}, verifyToken: async () => ({}), users: {} });
  await app.ready();
  for (const [path, item] of Object.entries(app.swagger().paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters') continue;
      const planned = op['x-status'] === 'planned';
      const served = app.hasRoute({ method: method.toUpperCase(), url: path.replace(/\{(\w+)\}/g, ':$1') });
      assert.equal(served, !planned, `${method.toUpperCase()} ${path} is ${planned ? 'planned but served' : 'documented as implemented but not served'}`);
    }
  }
});

test('contracts contain no keys accidentally split off a string (an unquoted comma in YAML flow style)', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const nullable = new Set(['example', 'examples', 'default']);
  for (const file of ['../../src/api/openapi.yaml', '../../docs/asyncapi.yaml']) {
    const found = [];
    const walk = (value, path, inExample) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const example = inExample || nullable.has(key);
        if (child === null && !example) found.push(`${path}.${key}`);
        walk(child, `${path}.${key}`, example);
      }
    };
    walk(parse(readFileSync(new URL(file, import.meta.url), 'utf8')), '', false);
    assert.deepEqual(found, [], `${file}: quote these strings`);
  }
});
