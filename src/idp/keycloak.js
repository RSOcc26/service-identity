// Identity-provider adapter for the Keycloak Admin REST API (ADR-0003).
// The only module that knows Keycloak-specific APIs; everything else uses
// the account operations below.

export class IdpUnavailableError extends Error {}
export class IdpConflictError extends Error {}
export class IdpNotFoundError extends Error {}

const toAccount = (u) => ({
  sub: u.id,
  email: u.email ?? null,
  givenName: u.firstName ?? null,
  familyName: u.lastName ?? null,
  enabled: u.enabled !== false,
});

export const createKeycloakAdmin = ({ adminUrl, tokenUrl, clientId, clientSecret, fetchImpl = fetch, timeoutMs = 5000 }) => {
  let token = null;
  let tokenExpiresAt = 0;

  const request = async (url, init) => {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new IdpUnavailableError(`Identity provider unreachable: ${err.message}`);
    }
  };

  // Client-credentials token of the service account, reused until shortly before expiry
  const accessToken = async (force = false) => {
    if (!force && token && Date.now() < tokenExpiresAt - 30_000) return token;
    const res = await request(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) throw new IdpUnavailableError(`Identity provider token request failed: ${res.status}`);
    const body = await res.json();
    token = body.access_token;
    tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return token;
  };

  const call = async (method, path, body) => {
    const send = async (force) => request(`${adminUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken(force)}`,
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    if (res.status >= 500) throw new IdpUnavailableError(`Identity provider error: ${res.status}`);
    return res;
  };

  // Only Keycloak's own "User not found" means the account is gone; any other
  // 404 (wrong realm or URL, a proxy) is a misconfiguration and must never anonymize
  const userMissing = async (res) => res.status === 404
    && (await res.clone().json().catch(() => ({}))).error === 'User not found';

  const expectOk = async (res, what) => {
    if (res.ok) return res;
    if (await userMissing(res)) throw new IdpNotFoundError(`${what}: account not found`);
    if (res.status === 409) throw new IdpConflictError(`${what}: conflict`);
    throw new IdpUnavailableError(`${what}: unexpected status ${res.status}`);
  };

  return {
    // The account, or null when the provider explicitly reports it missing
    async getAccount(sub) {
      const res = await call('GET', `/users/${encodeURIComponent(sub)}`);
      if (await userMissing(res)) return null;
      return toAccount(await (await expectOk(res, 'get account')).json());
    },

    // One page of accounts, ordered by the provider
    async listAccounts({ first = 0, max = 500 } = {}) {
      const res = await expectOk(await call('GET', `/users?briefRepresentation=true&first=${first}&max=${max}`), 'list accounts');
      return (await res.json()).map(toAccount);
    },

    // Updates the login email and names; throws IdpConflictError for a taken email
    async updateAccount(sub, { email, givenName, familyName }) {
      const path = `/users/${encodeURIComponent(sub)}`;
      const current = await (await expectOk(await call('GET', path), 'update account')).json();
      // A new email is not verified, whoever set it
      const reverify = email !== current.email && {
        emailVerified: false,
        requiredActions: [...new Set([...(current.requiredActions ?? []), 'VERIFY_EMAIL'])],
      };
      await expectOk(await call('PUT', path, {
        ...current, email, firstName: givenName, lastName: familyName, ...reverify,
      }), 'update account');
    },

    // Deletes the account and its sessions; an account that is already gone counts as deleted
    async deleteAccount(sub) {
      const res = await call('DELETE', `/users/${encodeURIComponent(sub)}`);
      if (await userMissing(res)) return;
      await expectOk(res, 'delete account');
    },
  };
};
