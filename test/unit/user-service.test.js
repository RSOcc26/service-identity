import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUserService, ConflictError, ForbiddenError, NotFoundError } from '../../src/domain/users.js';
import { IdpConflictError, IdpNoEmailError, IdpNotFoundError } from '../../src/idp/keycloak.js';
import { fakeDb, silentLogger } from './fake-db.js';

const ana = {
  id: 'u1', status: 'active', email: 'ana@test.local', displayName: 'Ana Novak',
  givenName: 'Ana', familyName: 'Novak', locale: 'sl', externalSubject: 'kc-1',
};
const emailTaken = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'users_email_key' });

test('remove: anonymizes, deactivates memberships, records the event and queues the provider deletion in one transaction', async () => {
  const db = fakeDb([
    [/FROM users WHERE id = \$1/, () => [ana]],
    [/UPDATE users SET status = 'deleted'/, () => [{ ...ana, status: 'deleted' }]],
    [/SELECT tenant_id FROM memberships/, () => [{ tenant_id: 't1' }, { tenant_id: 't2' }]],
  ]);
  await createUserService({ db, idp: {}, logger: silentLogger }).remove('u1', { actorId: 'admin', correlationId: 'r1' });

  const sql = db.log.map((q) => q.sql);
  const begin = sql.indexOf('BEGIN');
  const commit = sql.indexOf('COMMIT');
  const inTx = (pattern) => db.log.findIndex((q) => pattern.test(q.sql));
  for (const pattern of [/UPDATE users SET status = 'deleted'/, /UPDATE memberships/, /INSERT INTO outbox/, /INSERT INTO idp_tasks/]) {
    const at = inTx(pattern);
    assert.ok(at > begin && at < commit, `${pattern} runs inside the transaction`);
  }
  assert.equal(db.statements(/UPDATE memberships/).length, 2);
  const [event] = db.statements(/INSERT INTO outbox/);
  assert.equal(event.params[2].type, 'identity.user.deleted');
  assert.deepEqual(event.params[2].data, { userId: 'u1', reason: 'deleted-by-admin' });
  assert.equal(event.params[2].correlationId, 'r1');
  assert.deepEqual(db.statements(/INSERT INTO idp_tasks/)[0].params, ['delete-account', 'kc-1']);
});

test('remove: refuses to delete your own account; unknown users are 404; deleted users are a no-op', async () => {
  const admin = { ...ana, id: '0a7e0000-0000-4000-8000-000000000001' };
  const service = createUserService({ db: fakeDb([[/FROM users WHERE id/, ([id]) => {
    if (id === 'gone') return [{ ...ana, status: 'deleted' }];
    return id.toLowerCase() === admin.id ? [admin] : [];
  }]]), idp: {}, logger: silentLogger });
  await assert.rejects(service.remove(admin.id.toUpperCase(), { actorId: admin.id }), ForbiddenError);
  await assert.rejects(service.remove('nobody', { actorId: 'admin' }), NotFoundError);
  await service.remove('gone', { actorId: 'admin' });
});

test('update: changes the provider first, then the local row with an event', async () => {
  const order = [];
  const db = fakeDb([
    [/FROM users WHERE id = \$1/, () => [ana]],
    [/UPDATE users SET email/, (params) => { order.push('db'); return [{ ...ana, email: params[1] }]; }],
  ]);
  // The provider holds a newer family name from a console edit
  const idp = { updateAccount: async (sub, changes) => { order.push(['idp', sub, changes]); return { email: changes.email, givenName: 'Ana', familyName: 'Kos' }; } };
  const updated = await createUserService({ db, idp, logger: silentLogger }).update('u1', { email: 'new@test.local' });
  assert.deepEqual(order, [['idp', 'kc-1', { email: 'new@test.local' }], 'db']);
  assert.equal(updated.email, 'new@test.local');
  assert.equal(db.statements(/UPDATE users SET email/)[0].params[3], 'Kos', 'unchanged fields come from the provider');
  assert.equal(db.statements(/INSERT INTO outbox/)[0].params[2].type, 'identity.user.updated');
});

test('reconcileUser never overwrites a row changed after it was read', async () => {
  const seenAt = new Date('2026-11-06T10:00:00Z');
  const db = fakeDb([[/UPDATE users SET email/, () => []]]);
  const idp = { getAccount: async () => ({ sub: 'kc-1', email: 'console@test.local', givenName: 'Ana', familyName: 'Novak' }) };
  const result = await createUserService({ db, idp, logger: silentLogger }).reconcileUser({ ...ana, updatedAt: seenAt });
  assert.equal(result, 'unchanged');
  assert.equal(db.statements(/UPDATE users SET email/)[0].params[5], seenAt);
  assert.equal(db.statements(/INSERT INTO outbox/).length, 0);
});

test('reconcileUser publishes identity.user.updated when it copies a changed profile', async () => {
  const db = fakeDb([[/UPDATE users SET email/, () => [ana]]]);
  const idp = { getAccount: async () => ({ sub: 'kc-1', email: 'console@test.local', givenName: 'Ana', familyName: 'Novak' }) };
  assert.equal(await createUserService({ db, idp, logger: silentLogger }).reconcileUser(ana, { correlationId: 'r1' }), 'updated');
  const [event] = db.statements(/INSERT INTO outbox/);
  assert.deepEqual([event.params[2].type, event.params[2].correlationId], ['identity.user.updated', 'r1']);
});

test('update: an email still held by a stale local user is freed, then the edit is saved', async () => {
  let writes = 0;
  const bor = { ...ana, id: 'u2', email: 'bor@test.local', externalSubject: 'kc-2' };
  const db = fakeDb([
    [/FROM users WHERE id = \$1/, () => [ana]],
    [/lower\(email\) = lower\(\$1\)/, () => [bor]],
    [/UPDATE users SET status = 'deleted'/, () => [{ ...bor, status: 'deleted' }]],
    [/UPDATE users SET email/, ([id]) => { writes += 1; if (writes === 1) throw emailTaken; return [{ ...ana, id }]; }],
  ]);
  const idp = {
    updateAccount: async () => ({ email: 'bor@test.local', givenName: 'Ana', familyName: 'Novak' }),
    getAccount: async () => null, // bor's account is gone at the provider
  };
  await createUserService({ db, idp, logger: silentLogger }).update('u1', { email: 'bor@test.local' });
  assert.equal(writes, 2);
  assert.equal(db.statements(/UPDATE users SET status = 'deleted'/)[0].params[0], 'u2');
});

test('update: an account without an email at the provider is a conflict and nothing changes locally', async () => {
  const db = fakeDb([[/FROM users WHERE id = \$1/, () => [ana]]]);
  const idp = { updateAccount: async () => { throw new IdpNoEmailError('no email'); } };
  await assert.rejects(createUserService({ db, idp, logger: silentLogger }).update('u1', { givenName: 'Anja' }), ConflictError);
  assert.equal(db.statements(/UPDATE users/).length, 0);
});

test('update: a taken email is a conflict and nothing changes locally', async () => {
  const db = fakeDb([[/FROM users WHERE id = \$1/, () => [ana]]]);
  const idp = { updateAccount: async () => { throw new IdpConflictError('taken'); } };
  await assert.rejects(createUserService({ db, idp, logger: silentLogger }).update('u1', { email: 'b@test.local' }), ConflictError);
  assert.equal(db.statements(/UPDATE users/).length, 0);
});

test('update: an account gone at the provider anonymizes the user and returns 404', async () => {
  const db = fakeDb([
    [/FROM users WHERE id = \$1/, () => [ana]],
    [/UPDATE users SET status = 'deleted'/, () => [{ ...ana, status: 'deleted' }]],
  ]);
  const idp = { updateAccount: async () => { throw new IdpNotFoundError('gone'); }, getAccount: async () => null };
  await assert.rejects(createUserService({ db, idp, logger: silentLogger }).update('u1', { givenName: 'X' }), NotFoundError);
  assert.equal(db.statements(/UPDATE users SET status = 'deleted'/).length, 1);
  assert.equal(db.statements(/INSERT INTO idp_tasks/).length, 0, 'no provider task for an account that is already gone');
});

test('signIn: publishes identity.user.updated only when the claims changed the profile', async () => {
  for (const updated of [true, false]) {
    const db = fakeDb([[/INSERT INTO users/, () => [{ ...ana, updated }]]]);
    const user = await createUserService({ db, idp: {}, logger: silentLogger }).signIn({ sub: 'kc-1', email: ana.email }, { correlationId: 'r1' });
    assert.equal('updated' in user, false);
    assert.equal(db.statements(/INSERT INTO outbox/).length, updated ? 1 : 0);
  }
});

test('signIn: an email left behind by an account deleted at the provider is freed, then the new user is created', async () => {
  let insertAttempts = 0;
  const db = fakeDb([
    [/INSERT INTO users/, () => {
      insertAttempts += 1;
      if (insertAttempts === 1) throw emailTaken;
      return [{ ...ana, id: 'u2', externalSubject: 'kc-new' }];
    }],
    [/lower\(email\) = lower\(\$1\)/, () => [ana]],
    [/UPDATE users SET status = 'deleted'/, () => [{ ...ana, status: 'deleted' }]],
  ]);
  const idp = { getAccount: async (sub) => (sub === 'kc-1' ? null : undefined) };
  const user = await createUserService({ db, idp, logger: silentLogger })
    .signIn({ sub: 'kc-new', email: 'ana@test.local', name: 'Ana Novak', emailVerified: true });
  assert.equal(user.id, 'u2');
  assert.equal(insertAttempts, 2);
  assert.equal(db.statements(/UPDATE users SET status = 'deleted'/)[0].params[0], 'u1');
});

test('signIn: an email still owned by another live account is a conflict, not a takeover', async () => {
  const db = fakeDb([
    [/INSERT INTO users/, () => { throw emailTaken; }],
    [/lower\(email\) = lower\(\$1\)/, () => [ana]],
  ]);
  const idp = { getAccount: async () => ({ sub: 'kc-1', email: 'ana@test.local', givenName: 'Ana', familyName: 'Novak' }) };
  await assert.rejects(createUserService({ db, idp, logger: silentLogger })
    .signIn({ sub: 'kc-new', email: 'ana@test.local', emailVerified: true }), ConflictError);
  assert.equal(db.statements(/UPDATE users SET status = 'deleted'/).length, 0);
});

test('signIn: an unverified email never triggers a repair of another user', async () => {
  const db = fakeDb([[/INSERT INTO users/, () => { throw emailTaken; }], [/lower\(email\)/, () => [ana]]]);
  const idp = { getAccount: async () => { throw new Error('must not be called'); } };
  await assert.rejects(createUserService({ db, idp, logger: silentLogger })
    .signIn({ sub: 'kc-new', email: 'ana@test.local', emailVerified: false }), ConflictError);
  assert.equal(db.statements(/lower\(email\)/).length, 0);
});

test('signIn: an email swap at the provider ends as a conflict, not a 500', async () => {
  let inserts = 0;
  const db = fakeDb([
    [/INSERT INTO users/, () => { inserts += 1; throw emailTaken; }],
    [/lower\(email\)/, () => [ana]],
    [/UPDATE users SET email/, () => { throw emailTaken; }],
  ]);
  const idp = { getAccount: async () => ({ sub: 'kc-1', email: 'someone-else@test.local', givenName: 'Ana', familyName: 'Novak' }) };
  await assert.rejects(createUserService({ db, idp, logger: silentLogger })
    .signIn({ sub: 'kc-new', email: 'ana@test.local', emailVerified: true }), ConflictError);
});

test('update: a user deleted while the provider call ran is a conflict and records no event', async () => {
  const db = fakeDb([[/FROM users WHERE id = \$1/, () => [ana]], [/UPDATE users SET email/, () => []]]);
  const idp = { updateAccount: async () => ({ ...ana, givenName: 'X' }) };
  await assert.rejects(createUserService({ db, idp, logger: silentLogger }).update('u1', { givenName: 'X' }), ConflictError);
  assert.equal(db.statements(/^ROLLBACK/).length, 1);
  assert.equal(db.statements(/^COMMIT/).length, 0);
});

test('list: pages are ordered by a unique tiebreaker, so no user repeats or goes missing', async () => {
  const db = fakeDb([[/count\(\*\)/i, () => [{ total: 0 }]]]);
  await createUserService({ db, idp: {}, logger: silentLogger }).list({ limit: 10, offset: 0 });
  assert.match(db.statements(/ORDER BY/)[0].sql, /ORDER BY .*, id LIMIT/);
});
