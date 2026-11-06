import { createRemoteJWKSet, jwtVerify } from 'jose';

// Verifies the tenant context signed by the gateway (ADR-0001) against the
// gateway's JWKS; returns its claims. Browser tokens are never accepted here.
export const createVerifier = ({ jwksUrl, issuer, audience }) => {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async (token) => (await jwtVerify(token, jwks, {
    issuer,
    audience,
    typ: 'tenant-context+jwt',
    algorithms: ['ES256'],
  })).payload;
};
