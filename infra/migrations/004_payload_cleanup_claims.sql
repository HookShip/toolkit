BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('webhook-portal-reference-migrations', 0)
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
  ) OR NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '003_reference_recovery'
  ) OR EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version NOT IN (
      '001_initial',
      '002_persistence_hardening',
      '003_reference_recovery',
      '004_payload_cleanup_claims'
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
      OR
      (version = '004_payload_cleanup_claims' AND checksum IS DISTINCT FROM
        '4966d98d9a0d7d8d2f52c83e92e3515252157375228b6b7739be9157c65c63a1')
  ) THEN
    RAISE EXCEPTION 'reference migration state is not safe to modify';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS reference_payload_cleanup_claims (
  object_key text PRIMARY KEY,
  claim_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('claimed', 'deleting', 'deleted')),
  reason text NOT NULL CHECK (
    reason IN ('legacy_orphan', 'stale_upload_intent')
  ),
  upload_intent_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  last_error_code text,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_payload_cleanup_claims_lease
  ON reference_payload_cleanup_claims(state, lease_expires_at, object_key);

INSERT INTO reference_schema_migrations(version, checksum)
VALUES (
  '004_payload_cleanup_claims',
  '4966d98d9a0d7d8d2f52c83e92e3515252157375228b6b7739be9157c65c63a1'
)
ON CONFLICT(version) DO UPDATE
SET checksum = EXCLUDED.checksum
WHERE reference_schema_migrations.checksum IS NULL;

COMMIT;
