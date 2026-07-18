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
  ) OR NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '004_payload_cleanup_claims'
  ) OR NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '005_payload_generations'
  ) OR NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '006_persistence_definitive'
  ) OR NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '007_payload_storage_identity'
  ) OR NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '008_namespace_binding_timeline_identity'
  ) OR NOT EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version = '009_namespace_derived_bucket'
  ) OR EXISTS (
    SELECT 1 FROM reference_schema_migrations
    WHERE version NOT IN (
      '001_initial',
      '002_persistence_hardening',
      '003_reference_recovery',
      '004_payload_cleanup_claims',
      '005_payload_generations',
      '006_persistence_definitive',
      '007_payload_storage_identity',
      '008_namespace_binding_timeline_identity',
      '009_namespace_derived_bucket',
      '010_payload_store_identity'
    )
  ) OR EXISTS (
    SELECT 1 FROM reference_schema_migrations
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
      OR
      (version = '005_payload_generations' AND checksum IS DISTINCT FROM
        '0ab47c79c23ac173971df991b420c4e814e8f5788372c0843943381be4bc4e35')
      OR
      (version = '006_persistence_definitive' AND checksum IS DISTINCT FROM
        'b54668b181899d36c0a7405495f61622bf6f045d430b2eb593f5821ad8180941')
      OR
      (version = '007_payload_storage_identity' AND checksum IS DISTINCT FROM
        '53605bec9bcf181bfafeaa7fbca973e82cb679d50a8b562ff033da26719a634d')
      OR
      (version = '008_namespace_binding_timeline_identity' AND checksum IS DISTINCT FROM
        '32ddcf4da2aefe3e417c11080b8e7dc62d6515bd7d0e42b005caac965261e7bd')
      OR
      (version = '009_namespace_derived_bucket' AND checksum IS DISTINCT FROM
        'eefa0df78292fe5d578dd7f83db6856df2a15416f260ec0ebdac5b25d954ab1d')
      OR
      (version = '010_payload_store_identity' AND checksum IS DISTINCT FROM
        '75565f1e5e3e9ffc93de9ca1e4a5bb35362a98691d365280d14e119ca6a33f9a')
  ) THEN
    RAISE EXCEPTION 'reference migration state is not safe to modify';
  END IF;
END
$$;

ALTER TABLE reference_payload_storage_state
  ADD COLUMN IF NOT EXISTS store_id text;

ALTER TABLE reference_payload_storage_state
  DROP CONSTRAINT IF EXISTS reference_payload_storage_state_status_check;
ALTER TABLE reference_payload_storage_state
  ADD CONSTRAINT reference_payload_storage_state_status_check
  CHECK (status IN ('binding', 'ready', 'upgrading')) NOT VALID;

UPDATE reference_payload_storage_state
SET
  status = CASE WHEN status = 'ready' THEN 'upgrading' ELSE status END,
  record = (record - 'storeId') || jsonb_build_object(
    'status',
    CASE WHEN status = 'ready' THEN 'upgrading' ELSE status END
  )
WHERE store_id IS NULL
  AND (
    status = 'ready'
    OR record ? 'storeId'
    OR record->>'status' IS DISTINCT FROM status
  );

UPDATE reference_payload_storage_state
SET record = jsonb_set(
  jsonb_set(record, '{storeId}', to_jsonb(store_id), true),
  '{status}',
  to_jsonb(status),
  true
)
WHERE store_id IS NOT NULL
  AND (
    record->>'storeId' IS DISTINCT FROM store_id
    OR record->>'status' IS DISTINCT FROM status
  );

ALTER TABLE reference_payload_storage_state
  VALIDATE CONSTRAINT reference_payload_storage_state_status_check;

ALTER TABLE reference_payload_storage_state
  DROP CONSTRAINT IF EXISTS reference_payload_storage_state_store_id_check;
ALTER TABLE reference_payload_storage_state
  ADD CONSTRAINT reference_payload_storage_state_store_id_check
  CHECK (
    store_id IS NULL
    OR (
      store_id ~ '^[0-9a-f]{32}$'
      AND store_id <> namespace
    )
  ) NOT VALID;
ALTER TABLE reference_payload_storage_state
  VALIDATE CONSTRAINT reference_payload_storage_state_store_id_check;

ALTER TABLE reference_payload_storage_state
  DROP CONSTRAINT IF EXISTS reference_payload_storage_state_ready_store_check;
ALTER TABLE reference_payload_storage_state
  ADD CONSTRAINT reference_payload_storage_state_ready_store_check
  CHECK (status <> 'ready' OR store_id IS NOT NULL) NOT VALID;
ALTER TABLE reference_payload_storage_state
  VALIDATE CONSTRAINT reference_payload_storage_state_ready_store_check;

INSERT INTO reference_schema_migrations(version, checksum)
VALUES ('010_payload_store_identity', '75565f1e5e3e9ffc93de9ca1e4a5bb35362a98691d365280d14e119ca6a33f9a')
ON CONFLICT(version) DO UPDATE
SET checksum = EXCLUDED.checksum
WHERE reference_schema_migrations.checksum IS NULL;

COMMIT;
