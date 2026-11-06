import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT } from 'jose';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createVerifier } from '../../src/api/auth.js';

// In CI the contract repositories are listed in CONTRACT_REPOSITORIES and must
// be present; locally the comparison is skipped when the checkout is missing
const requiredInCi = (repository) =>
  (process.env.CONTRACT_REPOSITORIES ?? '').split(/\s+/).includes(repository);

// Tokens that match the shared contract (.github/docs/contracts) are accepted
const COPY = new URL('../contracts/tenant-context.schema.json', import.meta.url);
const CANONICAL = new URL('../../../.github/docs/contracts/tenant-context.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(COPY, 'utf8'));
const ajv = addFormats(new Ajv({ strict: false, allErrors: true }));
ajv.addSchema(schema, 'tc');

let server; let verify; let privateKey; let kid;
before(async () => {
  const keys = await generateKeyPair('ES256', { extractable: true });
  privateKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  kid = await calculateJwkThumbprint(jwk);
  server = createServer((req, res) => res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'ES256', use: 'sig' }] })));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  verify = createVerifier({
    jwksUrl: `http://127.0.0.1:${server.address().port}/.well-known/jwks.json`,
    issuer: 'companycentral-gateway',
    audience: 'service-identity',
  });
});
after(() => server.close());

const now = Math.floor(Date.now() / 1000);
const registered = () => ({ iss: 'companycentral-gateway', aud: 'service-identity', iat: now, exp: now + 60, jti: randomUUID() });
const contexts = {
  user: { rid: 'req-1', sub: randomUUID(), roles: ['platform-admin'], idp_iss: 'http://localhost:8180/realms/companycentral', idp_sub: 'kc-1', idp_iat: now, email: 'ana@test.local', email_verified: true, name: 'Ana Novak', given_name: 'Ana', family_name: 'Novak' },
  firstSignIn: { rid: 'req-2', roles: [], idp_iss: 'http://localhost:8180/realms/companycentral', idp_sub: 'kc-2', idp_iat: now },
  service: { rid: 'req-3', svc: 'gateway' },
};

for (const [name, claims] of Object.entries(contexts)) {
  test(`a ${name} context that matches the contract is accepted`, async () => {
    const header = { alg: 'ES256', typ: 'tenant-context+jwt', kid };
    const payload = { ...registered(), ...claims };
    assert.ok(ajv.getSchema('tc#/definitions/header')(header));
    const validate = ajv.getSchema('tc#/definitions/payload');
    assert.ok(validate(payload), ajv.errorsText(validate.errors));
    const token = await new SignJWT(claims).setProtectedHeader(header)
      .setIssuer(payload.iss).setAudience(payload.aud).setIssuedAt(payload.iat).setExpirationTime(payload.exp).setJti(payload.jti)
      .sign(privateKey);
    assert.equal((await verify(token)).rid, claims.rid);
  });
}

test('the schema copy is identical to the canonical one (when .github is checked out next to it)', { skip: !existsSync(CANONICAL) && !requiredInCi('.github') && 'no .github checkout next to this repository' }, () => {
  assert.equal(readFileSync(COPY, 'utf8'), readFileSync(CANONICAL, 'utf8'));
});
