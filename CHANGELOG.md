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
