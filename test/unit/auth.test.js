import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createVerifier } from '../../src/api/auth.js';

// A stand-in for the gateway's JWKS endpoint
let server; let verify; let privateKey;
before(async () => {
  const keys = await generateKeyPair('ES256', { extractable: true });
  privateKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'gw-1', alg: 'ES256', use: 'sig' };
  server = createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  verify = createVerifier({
    jwksUrl: `http://127.0.0.1:${server.address().port}/.well-known/jwks.json`,
    issuer: 'companycentral-gateway',
    audience: 'service-identity',
  });
});
after(() => server.close());

const context = ({ typ = 'tenant-context+jwt', aud = 'service-identity', iss = 'companycentral-gateway', exp = '60s', iat, jti = crypto.randomUUID() } = {}) => {
  const jwt = new SignJWT({ idp_sub: 'kc-1', email: 'ana@test.local' })
    .setProtectedHeader({ alg: 'ES256', kid: 'gw-1', typ })
    .setIssuer(iss).setAudience(aud);
  if (iat !== null) jwt.setIssuedAt(iat);
  if (exp !== null) jwt.setExpirationTime(exp);
  if (jti !== null) jwt.setJti(jti);
  return jwt.sign(privateKey);
};

test('accepts a tenant context signed by the gateway', async () => {
  const claims = await verify(await context());
  assert.equal(claims.idp_sub, 'kc-1');
});

test('rejects another JWT type, audience, issuer or an expired context', async () => {
  await assert.rejects(verify(await context({ typ: 'JWT' })));
  await assert.rejects(verify(await context({ aud: 'service-inventory' })));
  await assert.rejects(verify(await context({ iss: 'http://localhost:8180/realms/companycentral' })));
  await assert.rejects(verify(await context({ exp: '-10s' })));
});

test('rejects a context without exp, iat or jti, an old one, or one for several services', async () => {
  await assert.rejects(verify(await context({ exp: null })));
  await assert.rejects(verify(await context({ iat: null })));
  await assert.rejects(verify(await context({ jti: null })));
  await assert.rejects(verify(await context({ iat: Math.floor(Date.now() / 1000) - 120, exp: '1h' })));
  await assert.rejects(verify(await context({ aud: ['service-identity', 'service-inventory'] })));
});
