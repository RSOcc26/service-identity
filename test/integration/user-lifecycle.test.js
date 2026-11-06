import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/data/migrate.js';
import {
  upsertUser, anonymizeUser, deactivateMemberships, updateProfile, findById, EmailTakenError, UserDeletedError,
} from '../../src/data/users.js';
import { enqueueEvent, enqueueIdpTask } from '../../src/data/outbox.js';

// Runs as the runtime role (RLS applies, no DELETE); every test is rolled back
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const ctx = (tenant = '', user = '') =>
  q("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenant, user]);

let a, b, sub, email;

before(async () => {
  await migrate({ info() {}, warn() {}, error() {}, debug() {} });
  await db.connect();
});
after(() => db.end());
beforeEach(async () => {
  await q('BEGIN');
  [{ a, b }] = await q('SELECT uuidv7() a, uuidv7() b');
  sub = `kc-${a}`;
  email = `${a}@test.local`;
  for (const id of [a, b]) {
    await ctx(id);
    await q("INSERT INTO companies (id, name) VALUES ($1, 'Test')", [id]);
  }
  await ctx();
});
afterEach(() => q('ROLLBACK'));

test('anonymizing erases personal data, keeps the ID and frees the email', async () => {
  const user = await upsertUser(db, { sub, email, givenName: 'Ana', familyName: 'Novak' });
  assert.equal(user.displayName, 'Ana Novak');
  const deleted = await anonymizeUser(db, user.id);
  assert.equal(deleted.id, user.id);
  assert.deepEqual(
    [deleted.status, deleted.email, deleted.displayName, deleted.givenName, deleted.familyName],
    ['deleted', null, null, null, null],
  );
  assert.ok(deleted.deletedAt);
  // A new account may use the same email straight away
  const again = await upsertUser(db, { sub: `${sub}-new`, email, name: 'Ana' });
  assert.notEqual(again.id, user.id);
});

test('a deleted user is never revived by a sign-in with the old subject', async () => {
  const user = await upsertUser(db, { sub, email, name: 'Ana' });
  await anonymizeUser(db, user.id);
  await assert.rejects(upsertUser(db, { sub, email, name: 'Ana' }), UserDeletedError);
  assert.equal((await findById(db, user.id)).email, null);
});

test('anonymizing twice is a no-op', async () => {
  const user = await upsertUser(db, { sub, email, name: 'Ana' });
  assert.ok(await anonymizeUser(db, user.id));
  assert.equal(await anonymizeUser(db, user.id), null);
});

test('the database rejects a deleted user that still has personal data', async () => {
  const user = await upsertUser(db, { sub, email, name: 'Ana' });
  await q('SAVEPOINT s');
  await assert.rejects(q("UPDATE users SET status = 'deleted', deleted_at = now() WHERE id = $1", [user.id]), /users_personal_data/);
  await q('ROLLBACK TO SAVEPOINT s');
});

test('memberships are deactivated in every company within row-level security', async () => {
  const user = await upsertUser(db, { sub, email, name: 'Ana' });
  for (const tenant of [a, b]) {
    await ctx(tenant);
    await q('INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)', [tenant, user.id]);
  }
  await ctx();
  assert.equal(await deactivateMemberships(db, user.id), 2);
  await ctx('', user.id);
  const rows = await q('SELECT status FROM memberships WHERE user_id = $1', [user.id]);
  assert.deepEqual(rows.map((r) => r.status), ['inactive', 'inactive']);
});

test('a duplicate email surfaces as EmailTakenError on sign-in and on profile updates', async () => {
  const first = await upsertUser(db, { sub, email, name: 'Ana' });
  const other = await upsertUser(db, { sub: `${sub}-2`, email: `other-${email}`, name: 'Bor' });
  await q('SAVEPOINT s');
  await assert.rejects(upsertUser(db, { sub: `${sub}-3`, email: email.toUpperCase(), name: 'X' }), EmailTakenError);
  await q('ROLLBACK TO SAVEPOINT s');
  await assert.rejects(updateProfile(db, other.id, { email: first.email }), EmailTakenError);
  await q('ROLLBACK TO SAVEPOINT s');
});

test('the runtime role can write the outbox and provider tasks but cannot delete rows', async () => {
  await enqueueEvent(db, { type: 'identity.user.deleted', key: 'u1', data: { userId: 'u1' } });
  await enqueueIdpTask(db, { action: 'delete-account', externalSubject: sub });
  const [event] = await q("SELECT payload FROM outbox WHERE key = 'u1' ORDER BY created_at DESC LIMIT 1");
  assert.equal(event.payload.producer, 'service-identity');
  await q('SAVEPOINT s');
  await assert.rejects(q('DELETE FROM idp_tasks'), /permission denied/);
  await q('ROLLBACK TO SAVEPOINT s');
});

test('a token issued before the last change does not overwrite it', async () => {
  const user = await upsertUser(db, { sub, email, name: 'Ana' });
  await updateProfile(db, user.id, { email: `new-${email}`, givenName: 'Ana', familyName: 'Novak' });
  const staleIat = Math.floor(Date.now() / 1000) - 60;
  const after = await upsertUser(db, { sub, email, name: 'Ana', issuedAt: staleIat });
  assert.equal(after.email, `new-${email}`);
  const fresh = await upsertUser(db, { sub, email: `fresh-${email}`, name: 'Ana', issuedAt: Math.floor(Date.now() / 1000) + 5 });
  assert.equal(fresh.email, `fresh-${email}`);
});
