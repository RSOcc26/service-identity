import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIdpTasks, backoffMs, MAX_ATTEMPTS } from '../../src/jobs/idp-tasks.js';
import { reconcile, isSuspicious } from '../../src/jobs/reconcile.js';
import { relayOutbox } from '../../src/events/relay.js';
import { fakeDb, silentLogger } from './fake-db.js';

test('idp tasks: claimed with a lease, no transaction held; success marks done, failure retries with backoff', async () => {
  const db = fakeDb([[/^UPDATE idp_tasks SET attempts/, () => [
    { id: 't1', action: 'delete-account', external_subject: 'kc-1', attempts: 1 },
    { id: 't2', action: 'delete-account', external_subject: 'kc-2', attempts: 4 },
  ]]]);
  const idp = { deleteAccount: async (sub) => { if (sub === 'kc-2') throw new Error('provider down'); } };
  assert.equal(await runIdpTasks({ db, idp, logger: silentLogger }), 2);
  const [claim] = db.statements(/^UPDATE idp_tasks SET attempts/);
  assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/);
  assert.equal(db.statements(/^BEGIN/).length, 0);
  assert.deepEqual(db.statements(/SET done_at = now\(\)/)[0].params, ['t1']);
  const [retry] = db.statements(/SET last_error/);
  assert.deepEqual(retry.params, ['t2', 'provider down', 40, false]);
});

test('idp tasks: a task that keeps failing is parked after MAX_ATTEMPTS', async () => {
  const db = fakeDb([[/^UPDATE idp_tasks SET attempts/, () => [{ id: 't1', action: 'delete-account', external_subject: 'kc-1', attempts: MAX_ATTEMPTS }]]]);
  await runIdpTasks({ db, idp: { deleteAccount: async () => { throw new Error('403'); } }, logger: silentLogger });
  assert.equal(db.statements(/SET last_error/)[0].params[3], true);
});

test('idp task backoff grows and is capped at ten minutes', () => {
  assert.equal(backoffMs(0), 5_000);
  assert.equal(backoffMs(2), 20_000);
  assert.equal(backoffMs(20), 600_000);
});

const activeUsers = (n) => Array.from({ length: n }, (_, i) => ({
  id: `u${i}`, email: `u${i}@test.local`, givenName: 'U', familyName: `${i}`, externalSubject: `kc-${i}`,
}));
const reconcileDb = (users, locked = true) => fakeDb([
  [/pg_try_advisory_lock/, () => [{ locked }]],
  [/FROM users WHERE status = 'active'/, () => users],
]);
const recordingUsers = () => {
  const done = [];
  return { done, reconcileUser: async (u) => { done.push(u.id); return 'deleted'; } };
};

test('reconcile: an account missing from the listing is deleted only after a confirmed 404', async () => {
  const users = recordingUsers();
  const idp = {
    listAccounts: async () => [],
    // kc-0 really is gone; kc-1 exists but was not listed (for example a paging issue)
    getAccount: async (sub) => (sub === 'kc-0' ? null : { sub, email: 'u1@test.local', givenName: 'U', familyName: '1' }),
  };
  const result = await reconcile({ db: reconcileDb(activeUsers(2)), idp, users, logger: silentLogger });
  assert.deepEqual(users.done, ['u0']);
  assert.equal(result.deleted, 1);
});

test('reconcile: too many missing accounts deletes nothing', async () => {
  const users = recordingUsers();
  const idp = { listAccounts: async () => [], getAccount: async () => null };
  const result = await reconcile({ db: reconcileDb(activeUsers(30)), idp, users, logger: silentLogger, maxDeletions: 25 });
  assert.equal(result.skipped, true);
  assert.deepEqual(users.done, []);
});

test('reconcile: a failing provider listing deletes nothing', async () => {
  const users = recordingUsers();
  const idp = { listAccounts: async () => { throw new Error('down'); }, getAccount: async () => null };
  await assert.rejects(reconcile({ db: reconcileDb(activeUsers(3)), idp, users, logger: silentLogger }));
  assert.deepEqual(users.done, []);
});

test('reconcile: profile changes made at the provider are copied', async () => {
  const changed = [];
  const users = { reconcileUser: async (u) => { changed.push(u.id); return 'updated'; } };
  const [u0, u1] = activeUsers(2);
  const idp = {
    listAccounts: async () => [
      { sub: 'kc-0', email: 'renamed@test.local', givenName: 'U', familyName: '0' },
      { sub: 'kc-1', email: u1.email, givenName: 'U', familyName: '1' },
    ],
    getAccount: async () => { throw new Error('not expected'); },
  };
  const result = await reconcile({ db: reconcileDb([u0, u1]), idp, users, logger: silentLogger });
  assert.deepEqual(changed, ['u0']);
  assert.equal(result.updated, 1);
});

test('reconcile: only one replica runs at a time', async () => {
  const idp = { listAccounts: async () => { throw new Error('not expected'); } };
  assert.deepEqual(await reconcile({ db: reconcileDb([], false), idp, users: {}, logger: silentLogger }), { skipped: true });
});

test('reconcile guard: wrong-realm patterns delete nothing, a few real deletions pass', () => {
  assert.equal(isSuspicious(15, 15, 25), true, 'every user missing');
  assert.equal(isSuspicious(6, 10, 25), true, 'more than half');
  assert.equal(isSuspicious(30, 1000, 25), true, 'above the cap');
  assert.equal(isSuspicious(1, 10, 25), false);
  assert.equal(isSuspicious(1, 3, 25), false, 'small realm, one real deletion');
  assert.equal(isSuspicious(0, 0, 25), false);
});

test('relay: one runner at a time, ID order, marks only what Kafka accepted', async () => {
  const rows = [
    { id: '01', topic: 'identity.events', key: 'u1', payload: { type: 'identity.user.updated' } },
    { id: '02', topic: 'identity.events', key: 'u1', payload: { type: 'identity.user.deleted' } },
  ];
  const db = fakeDb([[/pg_try_advisory_lock/, () => [{ locked: true }]], [/FROM outbox WHERE published_at IS NULL/, () => rows]]);
  const sent = [];
  assert.equal(await relayOutbox({ db, publisher: { send: async (topic, messages) => sent.push(...messages) } }), 2);
  assert.match(db.statements(/FROM outbox/)[0].sql, /ORDER BY id/);
  assert.deepEqual(sent.map((m) => JSON.parse(m.value).type), ['identity.user.updated', 'identity.user.deleted']);
  assert.deepEqual(db.statements(/SET published_at/)[0].params, [['01', '02']]);
  assert.equal(db.statements(/pg_advisory_unlock/).length, 1);

  const failing = fakeDb([[/pg_try_advisory_lock/, () => [{ locked: true }]], [/FROM outbox WHERE published_at IS NULL/, () => rows]]);
  await assert.rejects(relayOutbox({ db: failing, publisher: { send: async () => { throw new Error('broker down'); } } }));
  assert.equal(failing.statements(/SET published_at/).length, 0, 'nothing marked when Kafka failed');
  assert.equal(failing.statements(/pg_advisory_unlock/).length, 1);

  const busy = fakeDb([[/pg_try_advisory_lock/, () => [{ locked: false }]]]);
  assert.equal(await relayOutbox({ db: busy, publisher: {} }), 0);
});
