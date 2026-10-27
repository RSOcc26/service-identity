import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/data/migrate.js';

// Runs as the runtime role; every test is rolled back
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const q = async (sql, params) => (await db.query(sql, params)).rows;
// Sets the per-transaction context the service will set from the verified tenant context
const ctx = (tenant = '', user = '') =>
  q("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenant, user]);
const companyIds = async () => (await q('SELECT id FROM companies ORDER BY id')).map((r) => r.id);

let a, b, u;

before(async () => {
  await migrate({ info() {}, warn() {}, error() {}, debug() {} });
  await db.connect();
});
after(() => db.end());

// Two companies; user u is a member of A only
beforeEach(async () => {
  await q('BEGIN');
  [{ a, b, u }] = await q('SELECT uuidv7() a, uuidv7() b, uuidv7() u');
  await q("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Test')", [u, `${u}@test.local`]);
  for (const id of [a, b]) {
    await ctx(id);
    await q("INSERT INTO companies (id, name) VALUES ($1, 'Test')", [id]);
  }
  await ctx(a);
  await q('INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)', [a, u]);
});
afterEach(() => q('ROLLBACK'));

test('without context no tenant data is visible', async () => {
  await ctx();
  assert.deepEqual(await companyIds(), []);
  assert.deepEqual(await q('SELECT * FROM memberships'), []);
});

test('a tenant sees only its own company and memberships', async () => {
  await ctx(b);
  assert.deepEqual(await companyIds(), [b]);
  assert.deepEqual(await q('SELECT * FROM memberships'), []);
});

test('a user sees their own memberships and companies across tenants', async () => {
  await ctx('', u);
  assert.deepEqual(await companyIds(), [a]);
  assert.equal((await q('SELECT * FROM memberships')).length, 1);
});

test('a tenant cannot insert into another tenant', async () => {
  await ctx(b);
  await assert.rejects(
    q('INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)', [a, u]),
    /row-level security/,
  );
});

test("a tenant cannot update another tenant's company", async () => {
  await ctx(b);
  await q("UPDATE companies SET name = 'Hacked' WHERE id = $1", [a]);
  await ctx(a);
  assert.equal((await q('SELECT name FROM companies')).at(0).name, 'Test');
});

test('the runtime role cannot delete', async () => {
  await assert.rejects(q('DELETE FROM users'), /permission denied/);
});
