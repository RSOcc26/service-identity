# Changelog

All notable changes to this service are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Repository scaffold.
- OpenAPI 3.1 contract (`src/api/openapi.yaml`) with the health, metrics and API docs endpoints.
- `.env.example` documenting the configuration.

### Changed

- Renamed the project from CompanyHub to CompanyCentral.
- Tenants share tables with a `tenant_id` column and row-level security instead of one schema per tenant (ADR-0004).
