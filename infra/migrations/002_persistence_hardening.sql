BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('webhook-portal-reference-migrations', 0)
);

CREATE TABLE IF NOT EXISTS reference_release_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_release_id text REFERENCES reference_releases(id) ON DELETE RESTRICT,
  next_sequence bigint NOT NULL CHECK (next_sequence > 0)
);
INSERT INTO reference_release_state(singleton, active_release_id, next_sequence)
SELECT
  true,
  (SELECT id FROM reference_releases WHERE active ORDER BY sequence DESC LIMIT 1),
  COALESCE((SELECT MAX(sequence) + 1 FROM reference_releases), 1)
ON CONFLICT(singleton) DO UPDATE SET
  active_release_id = COALESCE(
    reference_release_state.active_release_id,
    EXCLUDED.active_release_id
  ),
  next_sequence = GREATEST(
    reference_release_state.next_sequence,
    EXCLUDED.next_sequence
  );
DROP TRIGGER IF EXISTS reference_release_immutable_guard
  ON reference_releases;
UPDATE reference_releases SET active = false WHERE active;

CREATE TABLE IF NOT EXISTS reference_publish_commands (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  import_id text NOT NULL REFERENCES reference_contract_imports(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('requested', 'completed')),
  release_id text REFERENCES reference_releases(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_outbox_events (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text,
  correlation_id text NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_outbox_events_created
  ON reference_outbox_events(created_at, id);

ALTER TABLE reference_metadata_observations
  ADD COLUMN IF NOT EXISTS identity_key text;
UPDATE reference_metadata_observations
SET identity_key = 'legacy:' || delivery_id
WHERE identity_key IS NULL;
ALTER TABLE reference_metadata_observations
  ALTER COLUMN identity_key SET NOT NULL;
CREATE INDEX IF NOT EXISTS reference_metadata_observations_identity
  ON reference_metadata_observations(identity_key, ingested_at);

ALTER TABLE reference_metadata_timeline
  ADD COLUMN IF NOT EXISTS identity_key text;
UPDATE reference_metadata_timeline
SET identity_key = 'legacy:' || delivery_id
WHERE identity_key IS NULL;
ALTER TABLE reference_metadata_timeline
  ALTER COLUMN identity_key SET NOT NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'reference_metadata_timeline'::regclass
      AND conname = 'reference_metadata_timeline_pkey'
  ) THEN
    ALTER TABLE reference_metadata_timeline
      DROP CONSTRAINT reference_metadata_timeline_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'reference_metadata_timeline'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE reference_metadata_timeline
      ADD CONSTRAINT reference_metadata_timeline_identity_pkey
      PRIMARY KEY(identity_key);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS reference_metadata_timeline_delivery
  ON reference_metadata_timeline(delivery_id);

ALTER TABLE reference_payload_references
  ADD COLUMN IF NOT EXISTS endpoint_id text;
UPDATE reference_payload_references
SET endpoint_id = NULLIF(record ->> 'endpointId', '')
WHERE endpoint_id IS NULL;
UPDATE reference_payload_references AS payload
SET endpoint_id = timeline.endpoint_id
FROM reference_metadata_timeline AS timeline
WHERE payload.endpoint_id IS NULL
  AND payload.delivery_id = timeline.delivery_id;
CREATE INDEX IF NOT EXISTS reference_payload_references_endpoint
  ON reference_payload_references(endpoint_id);

CREATE TABLE IF NOT EXISTS reference_payload_cleanup_tasks (
  id text PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  endpoint_id text REFERENCES reference_endpoints(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('pending', 'failed')),
  reason text NOT NULL CHECK (reason IN ('endpoint_deleted', 'expired', 'orphaned')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_payload_cleanup_tasks_pending
  ON reference_payload_cleanup_tasks(state, created_at);

DROP TRIGGER IF EXISTS reference_endpoint_tombstone_guard
  ON reference_endpoints;
INSERT INTO reference_payload_cleanup_tasks(
  id,
  object_key,
  endpoint_id,
  state,
  reason,
  created_at,
  updated_at,
  attempts,
  record
)
SELECT
  'endpoint:' || payload.id,
  payload.object_key,
  endpoint.id,
  'pending',
  'endpoint_deleted',
  endpoint.updated_at,
  endpoint.updated_at,
  0,
  jsonb_build_object(
    'id', 'endpoint:' || payload.id,
    'objectKey', payload.object_key,
    'endpointId', endpoint.id,
    'state', 'pending',
    'reason', 'endpoint_deleted',
    'createdAt', endpoint.updated_at,
    'updatedAt', endpoint.updated_at,
    'attempts', 0
  )
FROM reference_payload_references AS payload
JOIN reference_endpoints AS endpoint
  ON endpoint.id = payload.endpoint_id
WHERE endpoint.state = 'deleted'
ON CONFLICT(id) DO NOTHING;

DELETE FROM reference_payload_references AS payload
USING reference_endpoints AS endpoint
WHERE endpoint.id = payload.endpoint_id
  AND endpoint.state = 'deleted';
DELETE FROM reference_metadata_observations AS observation
USING reference_metadata_timeline AS timeline,
      reference_endpoints AS endpoint
WHERE observation.identity_key = timeline.identity_key
  AND timeline.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';
DELETE FROM reference_metadata_timeline AS timeline
USING reference_endpoints AS endpoint
WHERE timeline.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';
DELETE FROM reference_subscriptions AS subscription
USING reference_endpoints AS endpoint
WHERE subscription.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';
DELETE FROM reference_secret_versions AS secret
USING reference_endpoints AS endpoint
WHERE secret.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';
DELETE FROM reference_test_commands AS command
USING reference_endpoints AS endpoint
WHERE command.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';

ALTER TABLE reference_endpoints
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE reference_endpoints
  ALTER COLUMN url DROP NOT NULL;
UPDATE reference_endpoints
SET
  url = NULL,
  deleted_at = COALESCE(deleted_at, updated_at),
  record = jsonb_build_object(
    'id', id,
    'createdAt', created_at,
    'updatedAt', updated_at,
    'deletedAt', COALESCE(deleted_at, updated_at),
    'state', 'deleted',
    'tombstoneVersion', 1
  )
WHERE state = 'deleted';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reference_endpoints'::regclass
      AND conname = 'reference_endpoints_state_check'
  ) THEN
    ALTER TABLE reference_endpoints
      ADD CONSTRAINT reference_endpoints_state_check
      CHECK (state IN ('active', 'paused', 'deleted'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reference_endpoints'::regclass
      AND conname = 'reference_endpoints_tombstone_check'
  ) THEN
    ALTER TABLE reference_endpoints
      ADD CONSTRAINT reference_endpoints_tombstone_check
      CHECK (
        (
          state = 'deleted'
          AND url IS NULL
          AND deleted_at IS NOT NULL
          AND NOT (record ? 'url')
          AND NOT (record ? 'description')
          AND NOT (record ? 'allowLocalNetwork')
        )
        OR
        (
          state IN ('active', 'paused')
          AND url IS NOT NULL
          AND deleted_at IS NULL
        )
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION reference_guard_endpoint_tombstone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reference endpoint tombstones cannot be deleted';
  END IF;
  IF OLD.state = 'deleted' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'reference endpoint tombstones are immutable';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS reference_endpoint_tombstone_guard
  ON reference_endpoints;
CREATE TRIGGER reference_endpoint_tombstone_guard
BEFORE UPDATE OR DELETE ON reference_endpoints
FOR EACH ROW EXECUTE FUNCTION reference_guard_endpoint_tombstone();

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY endpoint_id
      ORDER BY created_at DESC, id DESC
    ) AS active_rank
  FROM reference_secret_versions
  WHERE state = 'active'
),
revoked AS (
  UPDATE reference_secret_versions AS secret
  SET
    state = 'revoked',
    updated_at = now(),
    record = jsonb_set(
      jsonb_set(secret.record, '{state}', to_jsonb('revoked'::text), true),
      '{updatedAt}',
      to_jsonb(now()::text),
      true
    )
  FROM ranked
  WHERE ranked.id = secret.id
    AND ranked.active_rank > 1
  RETURNING secret.id, secret.endpoint_id, secret.updated_at
)
INSERT INTO reference_audit_events(
  id,
  created_at,
  action,
  resource_type,
  resource_id,
  result,
  record
)
SELECT
  'migration-002-secret-' || id,
  updated_at,
  'secret.migration_revoke_duplicate',
  'secret_version',
  id,
  'success',
  jsonb_build_object(
    'id', 'migration-002-secret-' || id,
    'createdAt', updated_at,
    'action', 'secret.migration_revoke_duplicate',
    'resourceType', 'secret_version',
    'resourceId', id,
    'result', 'success',
    'actorId', 'schema-migration',
    'correlationId', '002_persistence_hardening',
    'details', jsonb_build_object('endpointId', endpoint_id)
  )
FROM revoked
ON CONFLICT(id) DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS reference_secret_versions_one_active
  ON reference_secret_versions(endpoint_id)
  WHERE state = 'active';

CREATE OR REPLACE FUNCTION reference_guard_release_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reference releases are immutable';
END
$$;
DROP TRIGGER IF EXISTS reference_release_immutable_guard
  ON reference_releases;
CREATE TRIGGER reference_release_immutable_guard
BEFORE UPDATE OR DELETE ON reference_releases
FOR EACH ROW EXECUTE FUNCTION reference_guard_release_immutability();

INSERT INTO reference_schema_migrations(version)
VALUES ('002_persistence_hardening')
ON CONFLICT DO NOTHING;

COMMIT;
