BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('webhook-portal-reference-migrations', 0)
);

ALTER TABLE reference_schema_migrations
  ADD COLUMN IF NOT EXISTS checksum text;

UPDATE reference_schema_migrations
SET checksum = CASE version
  WHEN '001_initial' THEN
    '7ef37327f578b7b2cb8df2c410a96e039ca935da9341b64c30d65789b749b637'
  WHEN '002_persistence_hardening' THEN
    '6225e3bc588cf2c2e36e62bee89e35cd94257a715086c62977ea5f20b6a2fa5b'
END
WHERE checksum IS NULL
  AND version IN ('001_initial', '002_persistence_hardening')
  AND NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '003_reference_recovery'
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '001_initial'
  ) OR NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '002_persistence_hardening'
  ) OR EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version NOT IN (
      '001_initial',
      '002_persistence_hardening',
      '003_reference_recovery'
    )
  ) OR EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE
      (version = '001_initial' AND checksum IS DISTINCT FROM
        '7ef37327f578b7b2cb8df2c410a96e039ca935da9341b64c30d65789b749b637')
      OR
      (version = '002_persistence_hardening' AND checksum IS DISTINCT FROM
        '6225e3bc588cf2c2e36e62bee89e35cd94257a715086c62977ea5f20b6a2fa5b')
      OR
      (version = '003_reference_recovery' AND checksum IS DISTINCT FROM
        'ebcd386c8c8a006e692450584e7373ddcd62ffb66255afb497a1d4a4f32ab022')
  ) THEN
    RAISE EXCEPTION 'reference migration state is not safe to modify';
  END IF;
END
$$;

ALTER TABLE reference_schema_migrations
  ADD COLUMN IF NOT EXISTS checksum text;

CREATE TABLE IF NOT EXISTS reference_payload_upload_intents (
  id text PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  endpoint_id text REFERENCES reference_endpoints(id) ON DELETE RESTRICT,
  delivery_id text,
  state text NOT NULL CHECK (state IN ('pending', 'orphaned')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_payload_upload_intents_reconcile
  ON reference_payload_upload_intents(created_at, id);
CREATE INDEX IF NOT EXISTS reference_payload_upload_intents_endpoint
  ON reference_payload_upload_intents(endpoint_id);

INSERT INTO reference_schema_migrations(version, checksum)
VALUES (
  '003_reference_recovery',
  'ebcd386c8c8a006e692450584e7373ddcd62ffb66255afb497a1d4a4f32ab022'
)
ON CONFLICT(version) DO UPDATE
SET checksum = EXCLUDED.checksum
WHERE reference_schema_migrations.checksum IS NULL;

COMMIT;
