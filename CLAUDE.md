# CLAUDE.md

Guidance for AI coding agents (Claude Code and others) working in this
repository. The same shared sections appear in every RSOcc26 repository; only
the "This repository" section differs.

## The project

**CompanyHub** is a multi-tenant, cloud-native platform for small and
medium-sized companies: one Hub with single sign-on, users, companies, groups
and permissions, a shared mailbox, tasks and an activity log, into which
independent business apps plug in (process planning, production, inventory,
time tracking, purchasing, bookings, analytics). Each company (tenant) has
isolated data and switches on only the apps it needs.

Built for the *Cloud Computing Services* course (RSO 2026/27, FRI UL), but
developed as a production enterprise system: treat every change as if real
customers depend on it.

## Organization

GitHub organization [RSOcc26](https://github.com/RSOcc26), one repository per
deployable unit:

| Repository | Role |
|---|---|
| `web` | Frontend: Hub shell, app UIs, shared UI kit |
| `gateway` | API gateway: TLS, session, identity token, routing, rate limits |
| `service-identity` | Users, companies, memberships, invitations, sessions, tokens |
| `service-access` | App registry, apps per company, roles and access groups |
| `service-audit` | Activity log |
| `service-messaging` | Hub mailbox |
| `service-tasks` | Shared tasks |
| `.github` | Organization defaults: CONTRIBUTING, templates, profile |

Planned domain services: catalog, projects, inventory, production, time,
purchasing, planning, booking, analytics (CQRS read model) and notification
(serverless, event-triggered).

## Architecture rules

- Browser → Ingress → `web` (`/`) or `gateway` (`/api/*`) → services. Only the
  gateway is exposed; services are cluster-internal.
- **Database per service** (PostgreSQL). Never read or write another service's
  database. Inside a database, one schema per tenant, with row-level security
  as a second line of defense. Every query is tenant-scoped.
- **Synchronous REST for questions** ("is this allowed?"), **events for facts**
  ("work order released"). Events are written to an `outbox` table in the same
  transaction as the change; consumers are idempotent, keep a durable cursor
  and send failures to a dead-letter queue.
- Each service publishes an **OpenAPI 3.1** contract (served at `/api-docs`)
  and changes it before or together with the implementation. Breaking API or
  event changes need a new version, not an in-place edit.
- Every service exposes `/health/live`, `/health/ready` and `/metrics`
  (Prometheus) and logs structured JSON that includes the request ID.
- Configuration comes only from environment variables (12-factor);
  `.env.example` documents them with placeholder values.
- Stack: Node.js 24 (see `.nvmrc`), PostgreSQL, Docker, Docker Compose locally,
  Kubernetes with Helm, GitHub Actions, images in GitHub Container Registry.
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

Identity service: user accounts, companies (tenants), memberships, invitations and login sessions.

Owns: users, companies, memberships, invitations, sessions. No other service reads or writes this data directly; others go
through this service's API or its events.

Layout: `src/api/` (routes, validation, OpenAPI), `src/domain/` (business
rules, independent of HTTP and storage), `src/data/` (repositories, queries),
`src/events/` (outbox publishers, consumers), `src/config/`, `migrations/`,
`test/unit/`, `test/integration/` (against a real PostgreSQL), `docs/adr/`.
