-- Up Migration

-- Links a user to the OIDC token subject (Keycloak sub, ADR-0002)
ALTER TABLE users ADD COLUMN external_subject text NOT NULL;
CREATE UNIQUE INDEX users_external_subject_key ON users (external_subject);

-- Down Migration

ALTER TABLE users DROP COLUMN external_subject;
