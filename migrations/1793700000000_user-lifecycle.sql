-- Up Migration

-- User lifecycle (ADR-0003). A deleted user keeps its ID, so references in
-- other services stay valid, but no personal data.
ALTER TABLE users
  ADD COLUMN status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  ADD COLUMN given_name  text,
  ADD COLUMN family_name text,
  ADD COLUMN deleted_at  timestamptz,
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN display_name DROP NOT NULL,
  ADD CONSTRAINT users_personal_data CHECK (
    (status = 'active' AND email IS NOT NULL AND display_name IS NOT NULL AND deleted_at IS NULL)
    OR (status = 'deleted' AND email IS NULL AND display_name IS NULL
        AND given_name IS NULL AND family_name IS NULL AND deleted_at IS NOT NULL)
  );

-- Transactional outbox (architecture §5): written in the same transaction as
-- the change, published to Kafka by the relay, then marked published
CREATE TABLE outbox (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  topic        text NOT NULL,
  key          text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (created_at) WHERE published_at IS NULL;

-- Durable work against the identity provider, retried until done (ADR-0003)
CREATE TABLE idp_tasks (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  action           text NOT NULL CHECK (action IN ('delete-account')),
  external_subject text NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  done_at          timestamptz
);
CREATE INDEX idp_tasks_pending_idx ON idp_tasks (next_attempt_at) WHERE done_at IS NULL;

-- Runtime role: no DELETE; rows are marked published or done instead
GRANT SELECT, INSERT, UPDATE ON outbox, idp_tasks TO identity_app;

-- Down Migration

DROP TABLE idp_tasks, outbox;
ALTER TABLE users
  DROP CONSTRAINT users_personal_data,
  DROP COLUMN deleted_at,
  DROP COLUMN family_name,
  DROP COLUMN given_name,
  DROP COLUMN status;
ALTER TABLE users ALTER COLUMN email SET NOT NULL, ALTER COLUMN display_name SET NOT NULL;
