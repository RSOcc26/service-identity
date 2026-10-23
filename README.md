# service-identity

Identity service: users, companies (tenants), memberships, invitations and identity-related settings.

Part of **CompanyCentral**, a multi-tenant, cloud-native platform built for
the *Cloud Computing Services* course (RSO 2026/27, FRI UL).
See the [architecture](https://github.com/RSOcc26/.github/blob/main/docs/architecture.md) and the
[RSOcc26 organization](https://github.com/RSOcc26) for the other services.

> **Status:** scaffold — no implementation yet. API resources and events below
> are the planned design, not working features.

## Responsibilities

- User accounts and their profile data
- Companies (tenants) and the memberships linking users to them
- Invitations into a company
- Answering "is this user an active member of this company?" for the gateway

How users authenticate (custom credentials and tokens, or an external
OIDC provider such as Keycloak) is an **open decision**, see
[ADR-0007](https://github.com/RSOcc26/.github/blob/main/docs/adr/0007-identity-provider-open-decision.md). Until it is
decided, no authentication mechanism is implemented here, and user IDs are
kept independent of how users log in.

## Data ownership

This service owns its own PostgreSQL database; no other service reads or
writes it directly ([ADR-0003](https://github.com/RSOcc26/.github/blob/main/docs/adr/0003-database-per-service.md)).

Owns: users, companies, memberships, invitations.

Multi-tenancy: tenants share tables. Every tenant-owned row has a `tenant_id`,
and PostgreSQL row-level security restricts each transaction to the tenant
from the verified tenant context ([ADR-0004](https://github.com/RSOcc26/.github/blob/main/docs/adr/0004-multi-tenancy-shared-tables-rls.md),
[ADR-0008](https://github.com/RSOcc26/.github/blob/main/docs/adr/0008-tenant-context-validation.md)). Companies are the tenants. Memberships and invitations are tenant-scoped; user accounts are global (one person can belong to several companies).

## API

The OpenAPI 3.1 contract is [`src/api/openapi.yaml`](src/api/openapi.yaml) and
will be served at `/api-docs`. It currently defines only the operational
endpoints; resources are added contract-first, together with their
implementation.

| Interface | Description |
|---|---|
| Health | `/health/live` and `/health/ready` for Kubernetes probes |
| Metrics | `/metrics` in Prometheus format |
| API docs | `/api-docs`, the OpenAPI document |

Planned resources (through the gateway as `/api/identity/v1/...`):

| Resource | Path | Purpose |
|---|---|---|
| Users | `/v1/users` | Read and update the current user and users of a company |
| Companies | `/v1/companies` | Create a company; read and update its details |
| Memberships | `/v1/companies/{companyId}/memberships` | List, add, deactivate members |
| Invitations | `/v1/companies/{companyId}/invitations` | Invite by e-mail, accept, revoke |
| Membership check | `/v1/internal/memberships/check` | Internal, for the gateway: is the user an active member? |

## Events

Published through the transactional outbox to the `companycentral.events`
exchange; consumers are idempotent
([ADR-0006](https://github.com/RSOcc26/.github/blob/main/docs/adr/0006-rabbitmq-transactional-outbox.md)). Planned:

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
| `PORT` | no | HTTP port (default `3000`) |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error` (default `info`) |
| `DATABASE_URL` | yes | PostgreSQL URL of this service's database, runtime role |
| `DATABASE_MIGRATION_URL` | yes | Same database, migration role (used only by migrations) |
| `RABBITMQ_URL` | yes | RabbitMQ connection URL |
| `RABBITMQ_EXCHANGE` | no | Event exchange (default `companycentral.events`) |
| `TENANT_CONTEXT_JWKS_URL` | yes | Where to get the gateway's public keys for verifying the tenant context |
| `TENANT_CONTEXT_ISSUER` | yes | Expected issuer of the tenant context |
| `TENANT_CONTEXT_AUDIENCE` | yes | Expected audience (`service-identity`) |

## Getting started

Prerequisites: Node.js 24 (see `.nvmrc`), Docker, and the local stack from the
[deploy](https://github.com/RSOcc26/deploy) repository (PostgreSQL, RabbitMQ).

_Commands will be added with the first implementation._

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
