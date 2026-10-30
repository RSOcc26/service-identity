-- Up Migration

-- Request context, set per transaction with SET LOCAL; NULL (no rows) when missing
CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- Users: global, not tenant-owned; IDs independent of authentication (ADR-0002)
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  email        text NOT NULL,
  display_name text NOT NULL,
  locale       text NOT NULL DEFAULT 'sl' CHECK (locale IN ('sl', 'en')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- Companies: the tenants; companies.id is the tenant_id
CREATE TABLE companies (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Memberships: tenant-owned link between users and companies
CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES companies (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- RLS (ADR-0001): current tenant read/write; a user also reads own memberships and their companies
ALTER TABLE companies ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON companies USING (id = app_tenant_id());
CREATE POLICY member_read ON companies FOR SELECT
  USING (id IN (SELECT tenant_id FROM memberships WHERE user_id = app_user_id()));
CREATE POLICY tenant ON memberships USING (tenant_id = app_tenant_id());
CREATE POLICY own_read ON memberships FOR SELECT USING (user_id = app_user_id());

-- Runtime role: DML only, no DELETE (rows are deactivated via status)
GRANT SELECT, INSERT, UPDATE ON users, companies, memberships TO identity_app;

-- Down Migration

DROP TABLE memberships, companies, users;
DROP FUNCTION app_tenant_id(), app_user_id();
