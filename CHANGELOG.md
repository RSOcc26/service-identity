# Changelog

All notable changes to this service are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial repository scaffold.
- Fastify HTTP server with `/health/live` and `/health/ready`.
- PostgreSQL connection pool (`pg`); `/health/ready` returns 503 when the database is unreachable.
- `/api-docs` serving the OpenAPI document (JSON or YAML).
- `/metrics` with default Node.js process metrics in Prometheus format.
- Initial database schema (users, companies, memberships) with row-level security;
  migrations (`node-pg-migrate`) run on startup as the migration role.
- `GET /v1/me`: verifies the Keycloak access token (`jose`, JWKS) and returns the
  user, creating it on first call; `users.external_subject` links it to the token `sub`.

- User administration for platform admins (ADR-0003): `GET /v1/admin/users`,
  `GET`/`PATCH`/`DELETE /v1/admin/users/{id}`; delete anonymizes the user,
  deactivates memberships and deletes the Keycloak account through a retried
  task; `GET /v1/me` returns `platformRoles`.
- Keycloak Admin API adapter (`src/idp/keycloak.js`, `IDP_*` settings). Only
  Keycloak's own `User not found` counts as a missing account; any other `404`
  (wrong realm or URL) is an outage and never anonymizes. An email change
  resets `emailVerified` and requires verification.
- The tenant context must carry `exp`, `iat` and `jti`, be at most 60 s old and
  name exactly one audience; admin routes also require `sub`.
- Transactional outbox with a Kafka relay (`@confluentinc/kafka-javascript`);
  `identity.user.updated` and `identity.user.deleted` events (`docs/events.md`).
- Reconciliation with Keycloak (`RECONCILE_*`), and repair of an email left by
  an account deleted in Keycloak at sign-in.
- `GET /v1/internal/users/by-subject/{sub}` for the gateway.
- Migration `user-lifecycle`: `users.status`, `given_name`, `family_name`,
  `deleted_at`; `outbox` and `idp_tasks` tables.

### Changed

- `/v1/*` routes verify the gateway-signed context (`typ: tenant-context+jwt`,
  ES256, `TENANT_CONTEXT_*` settings) instead of the Keycloak access token;
  `GET /v1/me` takes the user from its `idp_sub`, `email` and `name` claims.
- Request bodies and query strings with unknown fields are rejected (`400`)
  instead of the fields being silently dropped.

### Fixed

- `identity.user.updated` is also published when sign-in or reconciliation
  changes a profile; an unchanged sign-in no longer rewrites the user row.
- Admin edits and reconciliation free an email still held by a stale local
  user, as sign-in already did, instead of failing with a conflict on every try.
- Editing a user whose email was removed in Keycloak returns 409 (unless the
  change sets an email) instead of 500, and Keycloak is left unchanged.
- Admin email edits are stored lowercased, as Keycloak stores them, so
  reconciliation stops rewriting them and a case-only change needs no re-verification.
- An admin can no longer delete their own account by sending their ID in
  uppercase; a `urn:uuid:` user ID returns 400 instead of 500.
- Sign-in: claims from a token issued before the user's last change (for
  example an admin edit) no longer overwrite it; an email conflict is repaired
  only for a verified email, and an email swap at Keycloak is a `409`, not a `500`.
- Editing a user who is deleted at the same time is a `409` and records no
  event; Fastify client errors (malformed JSON, wrong content type) keep their
  `4xx` instead of `500`.
- Keycloak tasks are claimed with a lease (no transaction held during the
  call) and parked after 50 attempts; the outbox relay runs as a single writer
  in ID order, so events of one user stay in order across replicas.
- Reconciliation also refuses to delete every user or more than half of them.
- `KAFKA_TOPIC` is honoured; `/v1/me` documents `409` and `503`.
- AsyncAPI 3.0 contract for `identity.events` (`docs/asyncapi.yaml`): published
  and planned events, delivery guarantees; contract tests for emitted events.
- Planned operations in the OpenAPI contract (`x-status: planned`): companies,
  memberships, invitations and the gateway's membership check.
- CI clones `.github` (`contract-repositories`) so the tenant-context schema
  copy is compared there.
- Tenant-context contract tests (`test/contracts/`) and `docs/keycloak.md`.
- `X-Request-Id` from the gateway is the request ID and is returned; every
  problem document has `correlationId`; unknown paths return a problem document.
- OpenAPI contract reviewed against the code: every returned status (including
  `400`, `413`, `415`), the `admin` and `internal` tags, examples, and the
  deleted-user semantics.

### Removed

- `OIDC_ISSUER` and `OIDC_JWKS_URL`: only the gateway talks to Keycloak.
