// SPDX-License-Identifier: Apache-2.0

import { migration } from "./migration.js";

export const migration006PersistenceDefinitive = migration(
  "006_persistence_definitive",
  `
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
`,
);
