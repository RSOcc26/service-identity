# Keycloak dependency

What `service-identity` needs from Keycloak (ADR-0002, ADR-0003). Anyone
changing the realm, upgrading Keycloak or replacing the provider checks this
list first. Only `src/idp/keycloak.js` talks to Keycloak directly; everything
else goes through its four operations.

## Service account

| Item | Value |
|---|---|
| Client | `service-identity`, confidential, service accounts on, no other flows |
| Credentials | `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET` (a Kubernetes Secret; locally `.env`) |
| Token | client credentials grant at `IDP_TOKEN_URL`; reused until 30 s before expiry, refreshed once on `401` |
| Roles | `realm-management`: `manage-users`, `view-users`, `query-users` |

Without these roles every admin operation fails with `503`, queued deletions are
retried with backoff and parked after 50 attempts, and reconciliation logs
errors but changes nothing.

## Admin API calls

All under `IDP_ADMIN_URL` (`.../admin/realms/<realm>`), 5 s timeout each.

| Operation | Call | How answers are treated |
|---|---|---|
| `getAccount(sub)` | `GET /users/{sub}` | `404` = the account is gone; any other error is an outage, never "gone" |
| `listAccounts` | `GET /users?briefRepresentation=true&first&max` (pages of 500) | used by reconciliation only to find candidates; nothing is deleted from a listing alone |
| `updateAccount(sub, …)` | `GET` then `PUT /users/{sub}` with `email`, `firstName`, `lastName` (other fields kept) | `409` = email taken (shown to the admin); `404` = gone (user is anonymized) |
| `deleteAccount(sub)` | `DELETE /users/{sub}` | `404` counts as deleted; Keycloak also ends the account's sessions |

The realm must use the email as username (`registrationEmailAsUsername`), so an
email change also changes the sign-in name, and must not allow duplicate emails.

## Token claims

Identity never sees Keycloak tokens: the gateway verifies them and copies these
claims into the tenant context (see the shared tenant-context contract).

| Keycloak claim | Context claim | Used for |
|---|---|---|
| `sub` | `idp_sub` | links the account to the CompanyCentral user (`users.external_subject`) |
| `iss` | `idp_iss` | recorded; one realm per environment |
| `iat` | `idp_iat` | claims older than the user's last stored change are ignored |
| `email`, `email_verified` | same | profile; only a verified email may free an email held by a vanished account |
| `name`, `given_name`, `family_name` | same | display name and names |
| `realm_access.roles` | `roles` (filtered) | `platform-admin` only |

The `web` and `api-docs` clients need the default `profile`, `email` and
`roles` scopes and the audience mapper that adds `aud: gateway`.

## What happens when Keycloak is down

| Situation | Effect |
|---|---|
| Sign-in, profile sync | unaffected (the token is already verified by the gateway) unless an email conflict needs repair: `503` |
| Admin edit | `503`, nothing changed |
| Admin delete | succeeds locally; the Keycloak deletion is queued and retried |
| Reconciliation | the run fails and is retried next interval; nothing is deleted |
