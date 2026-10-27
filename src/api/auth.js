import { createRemoteJWKSet, jwtVerify } from 'jose';

// Verifies an OIDC access token against the issuer's JWKS; returns its claims
export const createVerifier = ({ issuer, jwksUrl }) => {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async (token) => (await jwtVerify(token, jwks, { issuer })).payload;
};
