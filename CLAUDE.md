# CLAUDE.md

Guidance for AI coding agents (Claude Code and others) working in this
repository. The same shared sections appear in every RSOcc26 repository; only
the "This repository" section differs.

## The project

**CompanyCentral** is a multi-tenant, cloud-native platform for small and
medium-sized manufacturing companies: one Hub with users, companies,
memberships, roles and permissions, into which business applications plug in.
The first milestone covers work-order planning, inventory and production
execution. Each company (tenant) has isolated data and switches on only the
applications it needs.

Built for the *Cloud Computing Services* course (RSO 2026/27, FRI UL), but
developed as a production enterprise system: treat every change as if real
customers depend on it.

The architecture is described in
[docs/architecture.md](https://github.com/RSOcc26/.github/blob/main/docs/architecture.md)
and the cross-cutting decisions in
[docs/adr](https://github.com/RSOcc26/.github/tree/main/docs/adr).

## Organization

GitHub organization [RSOcc26](https://github.com/RSOcc26), one repository per
deployable unit:

| Repository | Role |
|---|---|
| `web` | React frontend: Hub shell, company switcher, app UIs, shared UI kit |
| `gateway` | API gateway: authentication, tenant context, routing, rate limits |
| `service-identity` | Users, companies (tenants), memberships, invitations |
| `service-access` | App registry, apps per company, roles, permissions, access groups |
| `service-workflow` | Catalog of articles and operations, projects, work orders, release |
| `service-inventory` | Stock locations, reservations, issuing, stock movements |
| `service-production` | Production execution, quantities, scrap, work-order completion |
| `deploy` | Docker Compose, Kubernetes, Helm charts, monitoring |
| `.github` | Organization defaults, reusable CI, architecture docs |

## Architecture rules

- Browser → Ingress → `web` (`/`) or `gateway` (`/api/*`) → services. Only the
  gateway is exposed; services are cluster-internal.
- **Database per service** (PostgreSQL). Never read or write another service's
  database. Tenants share tables: every tenant-owned row has a `tenant_id`, and
  PostgreSQL row-level security enforces it as a second line of defense. Every
  query is tenant-scoped.
- **Never trust a tenant ID from the client.** The gateway validates the user's
  membership and forwards a signed tenant context; services take the tenant
  only from that verified context.
- **Synchronous REST for questions** ("is this allowed?"), **events for facts**
  ("work order released") over Apache Kafka. Events are written to an
  `outbox` table in the same transaction as the change and published to the
  service's own topic; consumers are idempotent, commit offsets only after
  processing and send failures to their dead-letter topic.
- Each service publishes an **OpenAPI 3.1** contract (served at `/api-docs`)
  and changes it before or together with the implementation. Breaking API or
  event changes need a new version, not an in-place edit.
- Every service exposes `/health/live`, `/health/ready` and `/metrics`
  (Prometheus) and logs structured JSON that includes the request ID.
- Configuration comes only from environment variables (12-factor);
  `.env.example` documents them with placeholder values.
- Stack: Node.js 24 (see `.nvmrc`), React, PostgreSQL, Apache Kafka, Docker,
  Docker Compose locally, Kubernetes with Helm, GitHub Actions, images in
  GitHub Container Registry. No gRPC, GraphQL or event sourcing for now.
- Identity: custom identity vs. an external OIDC provider is an **open
  decision** (ADR-0002). Do not implement either authentication approach
  until it is decided.
- Significant design decisions get an ADR in `docs/adr/`.

## Working agreement for agents

**Git**
- **Never commit, push, merge, rebase, tag or create pull requests unless
  explicitly asked to in the current request.** Leave changes in the working
  tree for the developer to review. Permission to commit once does not carry
  over to later tasks.
- When asked to commit: work on a branch (`feat/…`, `fix/…`, `chore/…`,
  `docs/…`), never on `main`; use [Conventional Commits](https://www.conventionalcommits.org/).
- Never force-push, rewrite published history, or bypass hooks (`--no-verify`).
  `main` is protected and changes land only through reviewed, squash-merged
  pull requests.

**Permissions and safety**
- Ask before anything destructive or outward-facing: deleting files or data,
  dropping or resetting databases, running migrations against a shared
  environment, changing CI/CD, Kubernetes or Helm configuration, touching
  GitHub settings, or calling external services.
- Never commit or print secrets, keys, tokens or `.env` files. Do not weaken
  authentication, tenant isolation or input validation to make something work.
- Stay inside this repository. Changes needed in another repository are
  reported, not made, unless asked.
- Do not add dependencies without saying why; prefer well-maintained,
  widely used packages and pin versions.

**Quality**
- Keep changes small and focused on the request; match the surrounding code.
- Add or update tests with every behaviour change and run them before saying
  work is done. Report failures honestly.
- Database changes go through a new versioned migration in `migrations/`;
  never edit a migration that has been merged.
- Update `README.md`, the OpenAPI document and `CHANGELOG.md` (under
  `Unreleased`) when behaviour, configuration or the API change.
- Code, comments, commits and docs are in English; user-facing text is
  bilingual (sl/en).

See [CONTRIBUTING.md](https://github.com/RSOcc26/.github/blob/main/CONTRIBUTING.md)
for the full team workflow.

## This repository: `service-identity`

Identity service: users, companies (tenants), memberships, invitations and
identity-related settings.

Owns: users, companies, memberships, invitations. No other service reads or writes this data directly; others go
through this service's API or its events.

How users authenticate (custom or external OIDC) is an open decision (ADR-0002);
keep user IDs independent of it.

Layout: `src/api/` (routes, validation, OpenAPI), `src/domain/` (business
rules, independent of HTTP and storage), `src/data/` (repositories, queries),
`src/events/` (outbox publishers, consumers), `src/config/`, `migrations/`,
`test/unit/`, `test/integration/` (against a real PostgreSQL), `docs/adr/`.
