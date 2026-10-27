import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/data/migrate.js';
import { upsertUser } from '../../src/data/users.js';

// Runs as the runtime role; every test is rolled back
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

before(async () => {
  await migrate({ info() {}, warn() {}, error() {}, debug() {} });
  await db.connect();
});
after(() => db.end());
beforeEach(() => db.query('BEGIN'));
afterEach(() => db.query('ROLLBACK'));

test('upsertUser creates the user once per subject and syncs claims', async () => {
  const sub = `kc-${Date.now()}`;
  const first = await upsertUser(db, { sub, email: `${sub}@test.local`, name: 'Ana' });
  const again = await upsertUser(db, { sub, email: `${sub}@test.local`, name: 'Ana Novak' });
  assert.equal(again.id, first.id);
  assert.equal(again.displayName, 'Ana Novak');
  assert.equal(first.locale, 'sl');
});
