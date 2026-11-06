import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeycloakAdmin, IdpConflictError, IdpNotFoundError, IdpUnavailableError,
} from '../../src/idp/keycloak.js';

// Fake Keycloak: token endpoint plus scripted Admin API answers
const fakeKeycloak = (routes) => {
  const calls = [];
  let tokens = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body, auth: init.headers?.authorization });
    if (url === 'http://kc/token') {
      tokens += 1;
      return Response.json({ access_token: `t${tokens}`, expires_in: 300 });
    }
    const key = `${init.method ?? 'GET'} ${url.replace('http://kc/admin', '')}`;
    const route = routes[key];
    // Keycloak's own answer for an unknown user id
    if (!route) return Response.json({ error: 'User not found' }, { status: 404 });
    return typeof route === 'function' ? route(init) : route();
  };
  const idp = createKeycloakAdmin({ adminUrl: 'http://kc/admin', tokenUrl: 'http://kc/token', clientId: 'svc', clientSecret: 's', fetchImpl });
  return { idp, calls, tokenCount: () => tokens };
};

const kcUser = { id: 'kc-1', username: 'ana@test.local', email: 'ana@test.local', firstName: 'Ana', lastName: 'Novak', enabled: true };

test('getAccount maps the account and returns null only for 404', async () => {
  const { idp } = fakeKeycloak({ 'GET /users/kc-1': () => Response.json(kcUser) });
  assert.deepEqual(await idp.getAccount('kc-1'), { sub: 'kc-1', email: 'ana@test.local', givenName: 'Ana', familyName: 'Novak', enabled: true });
  assert.equal(await idp.getAccount('kc-missing'), null);
});

test('a provider outage is never mistaken for a missing account', async () => {
  const { idp } = fakeKeycloak({ 'GET /users/kc-1': () => new Response(null, { status: 503 }) });
  await assert.rejects(idp.getAccount('kc-1'), IdpUnavailableError);
  const offline = createKeycloakAdmin({
    adminUrl: 'http://kc/admin', tokenUrl: 'http://kc/token', clientId: 'svc', clientSecret: 's',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(offline.getAccount('kc-1'), IdpUnavailableError);
});

test('a 404 other than Keycloak "User not found" never counts as a missing account', async () => {
  const { idp } = fakeKeycloak({
    'GET /users/kc-1': () => Response.json({ error: 'Realm not found.' }, { status: 404 }),
    'DELETE /users/kc-1': () => new Response('Not Found', { status: 404 }),
  });
  await assert.rejects(idp.getAccount('kc-1'), IdpUnavailableError);
  await assert.rejects(idp.updateAccount('kc-1', { email: 'a@test.local' }), IdpUnavailableError);
  await assert.rejects(idp.deleteAccount('kc-1'), IdpUnavailableError);
});

test('the service-account token is reused and refreshed after a 401', async () => {
  let first = true;
  const { idp, tokenCount } = fakeKeycloak({
    'GET /users/kc-1': () => {
      if (first) { first = false; return new Response(null, { status: 401 }); }
      return Response.json(kcUser);
    },
  });
  await idp.getAccount('kc-1');
  assert.equal(tokenCount(), 2);
  await idp.getAccount('kc-1');
  assert.equal(tokenCount(), 2);
});

test('updateAccount keeps other fields and maps a taken email to a conflict', async () => {
  let sent;
  const { idp } = fakeKeycloak({
    'GET /users/kc-1': () => Response.json({ ...kcUser, attributes: { x: ['1'] } }),
    'PUT /users/kc-1': (init) => { sent = JSON.parse(init.body); return new Response(null, { status: 204 }); },
  });
  await idp.updateAccount('kc-1', { email: 'new@test.local', givenName: 'Ana', familyName: 'Kos' });
  assert.equal(sent.email, 'new@test.local');
  assert.equal(sent.lastName, 'Kos');
  assert.deepEqual(sent.attributes, { x: ['1'] });
  assert.equal(sent.emailVerified, false);
  assert.deepEqual(sent.requiredActions, ['VERIFY_EMAIL']);

  await idp.updateAccount('kc-1', { email: kcUser.email, givenName: 'Ana', familyName: 'Kos' });
  assert.equal(sent.emailVerified, undefined);

  const taken = fakeKeycloak({
    'GET /users/kc-1': () => Response.json(kcUser),
    'PUT /users/kc-1': () => new Response(null, { status: 409 }),
  });
  await assert.rejects(taken.idp.updateAccount('kc-1', { email: 'b@test.local' }), IdpConflictError);
  await assert.rejects(fakeKeycloak({}).idp.updateAccount('kc-x', {}), IdpNotFoundError);
});

test('deleteAccount treats an already missing account as deleted', async () => {
  const { idp, calls } = fakeKeycloak({ 'DELETE /users/kc-1': () => new Response(null, { status: 204 }) });
  await idp.deleteAccount('kc-1');
  await idp.deleteAccount('kc-gone');
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 2);
});
