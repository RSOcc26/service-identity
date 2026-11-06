# service-identity

Identity service: users, companies (tenants), memberships, invitations and identity-related settings.

Part of **CompanyCentral**, a multi-tenant, cloud-native platform built for
the *Cloud Computing Services* course (RSO 2026/27, FRI UL).
See the [architecture](https://github.com/RSOcc26/.github/blob/main/docs/architecture.md) and the
[RSOcc26 organization](https://github.com/RSOcc26) for the other services.

> **Status:** first slice. Implemented: `/v1/me`, platform-admin user
> administration, the Keycloak Admin API adapter, outbox relay, Keycloak task
> worker and reconciliation. Companies, memberships and invitations have tables
> but no API yet; the resources and events marked planned below are not built.

## Responsibilities

- User accounts and their profile data
- Companies (tenants) and the memberships linking users to them
- Invitations into a company
- Answering "is this user an active member of this company?" for the gateway

Users sign in with Keycloak, an external OIDC provider
([ADR-0002](https://github.com/RSOcc26/.github/blob/main/docs/adr/0002-identity-provider.md)).
This service stores no credentials and never sees Keycloak's tokens: the
gateway verifies them and forwards a signed, short-lived context
(`typ: tenant-context+jwt`, ES256), which this service verifies against the
gateway's JWKS (issuer, audience `service-identity`, expiry). Each user is
linked to the identity provider's subject (`idp_sub` in the context); user IDs
stay independent of how users log in.

## User lifecycle

Platform admins (Keycloak realm role `platform-admin`) edit and delete users
through `/v1/admin/users` ([ADR-0003](https://github.com/RSOcc26/.github/blob/main/docs/adr/0003-user-lifecycle.md)).
This service is the only writer to Keycloak, through its Admin API with the
`service-identity` service account, all in `src/idp/keycloak.js`.

| Operation | What happens |
|---|---|
| Edit | Keycloak first (owns the sign-in email, rejects duplicates), then the local row and an `identity.user.updated` event |
| Delete | One transaction: email and names erased, `status = deleted` (the ID stays), memberships deactivated, `identity.user.deleted` in the outbox, a `delete-account` task queued. The task worker deletes the Keycloak account with retries and backoff |
| Sign-in | Profile synced from the token; an email still held by a user whose Keycloak account is gone is freed first; a deleted user is never revived |
| Reconciliation | Every `RECONCILE_INTERVAL_SECONDS`: copies email and name changes made in Keycloak, and anonymizes users whose account Keycloak confirms is gone (per-user `404` only; capped by `RECONCILE_MAX_DELETIONS`) |

The gateway looks up every request's subject at
`/v1/internal/users/by-subject/{sub}` and rejects deleted users. Background
jobs lock their rows (`SKIP LOCKED`, an advisory lock for reconciliation), so
several replicas can run safely. Events are published from the `outbox` table
by the relay; see [docs/events.md](docs/events.md).

## Contracts

| Integration point | Contract |
|---|---|
| REST API (public through the gateway, and `/v1/internal/...` for the gateway) | [`src/api/openapi.yaml`](src/api/openapi.yaml), served at `/api-docs`; planned operations are marked `x-status: planned` |
| Events on `identity.events` | [`docs/asyncapi.yaml`](docs/asyncapi.yaml) (AsyncAPI 3.0), summary in [`docs/events.md`](docs/events.md) |
| The token every route requires | shared tenant-context contract in the `.github` repository (`docs/contracts/`); test copy in `test/contracts/` |
| What this service needs from Keycloak | [`docs/keycloak.md`](docs/keycloak.md) |

Contract tests in `test/unit/` check the code against each of them: emitted
events against the AsyncAPI schemas, accepted tokens against the tenant-context
schema, and that every documented operation is either served or marked planned.

## Data ownership

This service owns its own PostgreSQL database; no other service reads or
writes it directly ([ADR-0001](https://github.com/RSOcc26/.github/blob/main/docs/adr/0001-multi-tenancy.md)).

Owns: users, companies, memberships, invitations.

Multi-tenancy: tenants share tables. Every tenant-owned row has a `tenant_id`,
and PostgreSQL row-level security restricts each transaction to the tenant
from the verified tenant context ([ADR-0001](https://github.com/RSOcc26/.github/blob/main/docs/adr/0001-multi-tenancy.md)). Companies are the tenants. Memberships and invitations are tenant-scoped; user accounts are global (one person can belong to several companies).

## API

The OpenAPI 3.1 contract is [`src/api/openapi.yaml`](src/api/openapi.yaml) and
is served at `/api-docs` (JSON, or YAML with `Accept: application/yaml`). It defines the operational endpoints, `/v1/me`,
the platform-admin user routes and the internal subject lookup; further
resources are added contract-first, together with their implementation.

| Interface | Description |
|---|---|
| Health | `/health/live` and `/health/ready` for Kubernetes probes |
| Metrics | `/metrics` in Prometheus format |
| API docs | `/api-docs`, the OpenAPI document |

Resources (through the gateway as `/api/identity/v1/...`). Implemented: Me,
Admin users and the internal subject lookup; the rest is planned:

| Resource | Path | Purpose |
|---|---|---|
| Me | `/v1/me` | The signed-in user, created on first call (**implemented**) |
| Admin users | `/v1/admin/users[/{id}]` | Platform admins: list, get, patch, delete (anonymize) (**implemented**) |
| Subject lookup | `/v1/internal/users/by-subject/{sub}` | Internal, for the gateway: resolve the OIDC subject to a user (**implemented**) |
| Users | `/v1/users` | Read and update the current user and users of a company |
| Companies | `/v1/companies` | Create a company; read and update its details |
| Memberships | `/v1/companies/{companyId}/memberships` | List, add, deactivate members |
| Invitations | `/v1/companies/{companyId}/invitations` | Invite by e-mail, accept, revoke |
| Membership check | `/v1/internal/memberships/check` | Internal, for the gateway: is the user an active member? |

## Events

Published through the transactional outbox to the `identity.events` Kafka
topic, keyed by aggregate ID. Consumers are idempotent
([architecture](https://github.com/RSOcc26/.github/blob/main/docs/architecture.md#5-asynchronous-communication-events)).
Published now: `identity.user.updated` and `identity.user.deleted` (see
[docs/events.md](docs/events.md)). Planned:

| Direction | Event | Description |
|---|---|---|
| Publishes | `identity.company.created` | A company was created |
| Publishes | `identity.membership.added` | A user became a member of a company |
| Publishes | `identity.membership.removed` | A membership was deactivated |
| Publishes | `identity.invitation.accepted` | An invitation was accepted |

## Configuration

All configuration comes from environment variables; see
[`.env.example`](.env.example). Secrets are never committed; in Kubernetes
they come from Secrets, everything else from ConfigMaps.

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | HTTP port (default `3001`) |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error` (default `info`) |
| `DATABASE_URL` | yes | PostgreSQL URL of this service's database, runtime role |
| `DATABASE_MIGRATION_URL` | yes | Same database, migration role (used only by migrations) |
| `KAFKA_BROKERS` | yes | Comma-separated Kafka bootstrap servers |
| `KAFKA_CLIENT_ID` | no | Kafka client ID (default `service-identity`) |
| `KAFKA_TOPIC` | yes | Topic this service publishes to (`identity.events`) |
| `KAFKA_SASL_MECHANISM`, `KAFKA_USERNAME`, `KAFKA_PASSWORD` | in Kubernetes | SCRAM credentials of this service's Kafka user; empty for the local broker |
| `TENANT_CONTEXT_JWKS_URL` | yes | Where to get the gateway's public keys for verifying the tenant context |
| `TENANT_CONTEXT_ISSUER` | yes | Expected issuer of the tenant context |
| `TENANT_CONTEXT_AUDIENCE` | yes | Expected audience (`service-identity`) |
| `IDP_ADMIN_URL` | yes | Keycloak Admin API base of the realm |
| `IDP_TOKEN_URL` | yes | Token endpoint for the service account (client credentials) |
| `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET` | yes | The `service-identity` Keycloak client; the secret is a Kubernetes Secret |
| `OUTBOX_RELAY_INTERVAL_SECONDS` | no | How often pending events are published (default `2`) |
| `IDP_TASK_INTERVAL_SECONDS` | no | How often queued Keycloak tasks run (default `5`) |
| `RECONCILE_INTERVAL_SECONDS` | no | How often users are reconciled with Keycloak (default `300`) |
| `RECONCILE_MAX_DELETIONS` | no | Safety cap: a run that would delete more users deletes none (default `25`) |

## Getting started

Prerequisites: Node.js 24 (see `.nvmrc`), Docker, and the local stack from the
[deploy](https://github.com/RSOcc26/deploy) repository (PostgreSQL, Kafka).

```sh
cp .env.example .env   # set the database passwords from deploy/compose/.env
npm ci
npm start              # applies pending migrations, then listens on http://localhost:3001
npm test                 # unit tests
npm run test:integration # against the local PostgreSQL (docker compose up -d postgres)
```

Migrations are SQL files in `migrations/`, applied on startup with `DATABASE_MIGRATION_URL`
(later moved to a Kubernetes Job). Create one with
`npx node-pg-migrate create <name> --migration-file-language sql -m migrations`.

## Project structure

```
src/
  api/          HTTP routes, request validation, OpenAPI document
  domain/       business rules, independent of HTTP and storage
  data/         database access (repositories, queries)
  events/       outbox publisher and event consumers
  config/       configuration loading and validation
migrations/     versioned database migrations
test/
  unit/         fast tests with no external dependencies
  integration/  tests against a real database
docs/
  adr/          architecture decision records
```

## Deployment

Built as a container image and published to GitHub Container Registry.
Kubernetes manifests and Helm charts live in the deployment repository.

## Contributing

- Branch from `main` (`feat/…`, `fix/…`, `chore/…`) and open a pull request.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- Pull requests need a review from a code owner and passing checks; they are squash-merged.
- Record notable changes in `CHANGELOG.md`.

## License

[MIT](LICENSE)
