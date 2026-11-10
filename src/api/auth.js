import { createRemoteJWKSet, jwtVerify } from 'jose';

// Verifies the tenant context signed by the gateway (ADR-0001) against the
// gateway's JWKS; returns its claims. Browser tokens are never accepted here.
export const createVerifier = ({ jwksUrl, issuer, audience }) => {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      typ: 'tenant-context+jwt',
      algorithms: ['ES256'],
      requiredClaims: ['exp', 'iat', 'jti'],
      maxTokenAge: '60s',
      clockTolerance: '5s',
    });
    // The contract allows exactly one audience: a token for one service only
    if (typeof payload.aud !== 'string') throw new Error('tenant context must have a single audience');
    return payload;
  };
};
