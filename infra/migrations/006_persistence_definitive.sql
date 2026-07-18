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
  ) OR EXISTS (
    SELECT 1
    FROM reference_schema_migrations
    WHERE version NOT IN (
      '001_initial',
      '002_persistence_hardening',
      '003_reference_recovery',
      '004_payload_cleanup_claims',
      '005_payload_generations',
      '006_persistence_definitive'
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
      OR
      (version = '005_payload_generations' AND checksum IS DISTINCT FROM
        '0ab47c79c23ac173971df991b420c4e814e8f5788372c0843943381be4bc4e35')
      OR
      (version = '006_persistence_definitive' AND checksum IS DISTINCT FROM
        'b54668b181899d36c0a7405495f61622bf6f045d430b2eb593f5821ad8180941')
  ) THEN
    RAISE EXCEPTION 'reference migration state is not safe to modify';
  END IF;
END
$$;

ALTER TABLE reference_payload_references
  ALTER COLUMN upload_attempt_id SET NOT NULL;
ALTER TABLE reference_payload_references
  ALTER COLUMN upload_generation SET NOT NULL;

CREATE OR REPLACE FUNCTION reference_guard_payload_upload_object_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM reference_payload_references
    WHERE object_key = NEW.object_key
  ) THEN
    RAISE EXCEPTION 'referenced payload object keys cannot be uploaded again';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS reference_payload_upload_object_key_guard
  ON reference_payload_upload_intents;
CREATE TRIGGER reference_payload_upload_object_key_guard
BEFORE INSERT OR UPDATE OF object_key
ON reference_payload_upload_intents
FOR EACH ROW EXECUTE FUNCTION reference_guard_payload_upload_object_key();

CREATE OR REPLACE FUNCTION reference_guard_payload_reference_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM reference_payload_upload_intents
    WHERE id = NEW.upload_attempt_id
      AND object_key = NEW.object_key
      AND upload_generation = NEW.upload_generation
  ) THEN
    RAISE EXCEPTION 'payload reference ownership must match a live upload intent';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS reference_payload_reference_ownership_guard
  ON reference_payload_references;
CREATE TRIGGER reference_payload_reference_ownership_guard
BEFORE INSERT OR UPDATE OF object_key, upload_attempt_id, upload_generation
ON reference_payload_references
FOR EACH ROW EXECUTE FUNCTION reference_guard_payload_reference_ownership();

CREATE OR REPLACE FUNCTION reference_guard_payload_owner_exclusivity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_key text;
BEGIN
  candidate_key := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.object_key
    ELSE NEW.object_key
  END;
  IF EXISTS (
    SELECT 1
    FROM reference_payload_upload_intents AS intent
    JOIN reference_payload_references AS reference
      ON reference.object_key = intent.object_key
    WHERE intent.object_key = candidate_key
  ) THEN
    RAISE EXCEPTION 'payload object ownership cannot remain split';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS reference_payload_intent_exclusivity_guard
  ON reference_payload_upload_intents;
CREATE CONSTRAINT TRIGGER reference_payload_intent_exclusivity_guard
AFTER INSERT OR UPDATE OR DELETE ON reference_payload_upload_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reference_guard_payload_owner_exclusivity();
DROP TRIGGER IF EXISTS reference_payload_reference_exclusivity_guard
  ON reference_payload_references;
CREATE CONSTRAINT TRIGGER reference_payload_reference_exclusivity_guard
AFTER INSERT OR UPDATE OR DELETE ON reference_payload_references
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reference_guard_payload_owner_exclusivity();

INSERT INTO reference_schema_migrations(version, checksum)
VALUES (
  '006_persistence_definitive',
  'b54668b181899d36c0a7405495f61622bf6f045d430b2eb593f5821ad8180941'
)
ON CONFLICT(version) DO UPDATE
SET checksum = EXCLUDED.checksum
WHERE reference_schema_migrations.checksum IS NULL;

COMMIT;
