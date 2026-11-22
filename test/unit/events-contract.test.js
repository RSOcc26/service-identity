import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createUserService } from '../../src/domain/users.js';
import { fakeDb, silentLogger } from './fake-db.js';

// The events this service writes must match its AsyncAPI contract (docs/asyncapi.yaml)
const doc = parse(readFileSync(new URL('../../docs/asyncapi.yaml', import.meta.url), 'utf8'));
const ajv = addFormats(new Ajv({ strict: false, allErrors: true }));
ajv.addSchema(doc, 'asyncapi');
const validator = (name) => ajv.getSchema(`asyncapi#/components/schemas/${name}`);
const assertValid = (name, payload) => {
  const validate = validator(name);
  assert.ok(validate(payload), `${name}: ${ajv.errorsText(validate.errors)}`);
};

const messages = Object.values(doc.components.messages);
const schemaFor = (type) => messages.find((m) => m.name === type)?.payload.$ref.split('/').pop();

const ana = {
  id: '01a1a080-fb2c-7318-b5a8-fbf95c324543', status: 'active', email: 'ana@test.local', displayName: 'Ana Novak',
  givenName: 'Ana', familyName: 'Novak', locale: 'sl', externalSubject: 'kc-1',
};
const outboxPayloads = (db) => db.statements(/INSERT INTO outbox/).map((q) => q.params[2]);

test('the deletion event written by the code matches the contract', async () => {
  const db = fakeDb([
    [/FROM users WHERE id = \$1/, () => [ana]],
    [/UPDATE users SET status = 'deleted'/, () => [{ ...ana, status: 'deleted' }]],
  ]);
  await createUserService({ db, idp: {}, logger: silentLogger }).remove(ana.id, { actorId: 'admin', correlationId: 'req-1' });
  const [event] = outboxPayloads(db);
  assertValid(schemaFor(event.type), event);
});

test('the reconciliation deletion event matches the contract', async () => {
  const db = fakeDb([[/UPDATE users SET status = 'deleted'/, () => [{ ...ana, status: 'deleted' }]]]);
  const service = createUserService({ db, idp: { getAccount: async () => null }, logger: silentLogger });
  await service.reconcileUser(ana, { correlationId: 'reconciliation' });
  const [event] = outboxPayloads(db);
  assert.equal(event.data.reason, 'account-removed');
  assertValid(schemaFor(event.type), event);
});

test('the update event written by the code matches the contract', async () => {
  const db = fakeDb([
    [/FROM users WHERE id = \$1/, () => [ana]],
    [/UPDATE users SET email/, () => [ana]],
  ]);
  await createUserService({ db, idp: { updateAccount: async () => ana }, logger: silentLogger })
    .update(ana.id, { givenName: 'Ana' }, { correlationId: 'req-2' });
  const [event] = outboxPayloads(db);
  assertValid(schemaFor(event.type), event);
});

test('every event type the code can publish is in the contract', () => {
  const dir = new URL('../../src/', import.meta.url).pathname;
  const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js'));
  const types = new Set(files.flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/type: '(identity\.[a-z.-]+)'/g)].map((m) => m[1])));
  assert.ok(types.size > 0);
  for (const type of types) assert.ok(schemaFor(type), `${type} is missing from docs/asyncapi.yaml`);
});

test('published (not planned) messages each have a send operation, and examples are valid', () => {
  const sent = Object.values(doc.operations).flatMap((op) => op.messages.map((m) => m.$ref.split('/').pop()));
  for (const [key, message] of Object.entries(doc.channels.identityEvents.messages)) {
    assert.ok(sent.includes(key), `${key} has no operation`);
    const resolved = doc.components.messages[message.$ref.split('/').pop()];
    for (const example of resolved.examples ?? []) assertValid(resolved.payload.$ref.split('/').pop(), example.payload);
  }
});

test('the contract rejects events that break it', () => {
  const valid = {
    id: '9a7e2d41-0c6b-4e1f-b2d8-5f4a3c2b1e00', type: 'identity.user.deleted', version: 1,
    occurredAt: '2026-11-03T09:20:02.044Z', tenantId: null, correlationId: 'r', producer: 'service-identity',
    data: { userId: ana.id, reason: 'deleted-by-admin' },
  };
  const validate = validator('UserDeleted');
  assert.ok(validate(valid));
  assert.equal(validate({ ...valid, data: { ...valid.data, email: 'ana@test.local' } }), false, 'no personal data');
  assert.equal(validate({ ...valid, data: { userId: ana.id, reason: 'oops' } }), false);
  assert.equal(validate({ ...valid, producer: 'service-access' }), false);
});
