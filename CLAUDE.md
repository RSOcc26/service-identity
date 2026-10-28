# CLAUDE.md

Guidance for AI coding agents (Claude Code and others) working in this
repository. The shared, organization-wide guidance lives only in the `.github`
repository and is imported below; this file adds what is specific to this
repository.

@../.github/CLAUDE.md

If the import above did not load (no `.github` clone next to this repository,
or an agent without `@` imports), read
[.github/CLAUDE.md](https://github.com/RSOcc26/.github/blob/main/CLAUDE.md)
before making changes.

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
