// SPDX-License-Identifier: Apache-2.0

import { migration } from "./migration.js";

export const migration005PayloadGenerations = migration(
  "005_payload_generations",
  `
ALTER TABLE reference_payload_upload_intents
  ADD COLUMN IF NOT EXISTS upload_generation text;
UPDATE reference_payload_upload_intents
SET
  upload_generation = COALESCE(
    upload_generation,
    NULLIF(record ->> 'uploadGeneration', ''),
    'legacy:' || id
  ),
  record = jsonb_set(
    jsonb_set(
      record,
      '{uploadAttemptId}',
      to_jsonb(COALESCE(NULLIF(record ->> 'uploadAttemptId', ''), id)),
      true
    ),
    '{uploadGeneration}',
    to_jsonb(
      COALESCE(
        NULLIF(record ->> 'uploadGeneration', ''),
        upload_generation,
        'legacy:' || id
      )
    ),
    true
  )
WHERE upload_generation IS NULL
   OR NOT (record ? 'uploadAttemptId')
   OR NOT (record ? 'uploadGeneration');
ALTER TABLE reference_payload_upload_intents
  ALTER COLUMN upload_generation SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reference_payload_upload_intent_generation
  ON reference_payload_upload_intents(id, upload_generation, object_key);

ALTER TABLE reference_payload_references
  ADD COLUMN IF NOT EXISTS upload_attempt_id text;
ALTER TABLE reference_payload_references
  ADD COLUMN IF NOT EXISTS upload_generation text;
UPDATE reference_payload_references
SET
  upload_attempt_id = COALESCE(
    upload_attempt_id,
    NULLIF(record ->> 'uploadAttemptId', ''),
    id
  ),
  upload_generation = COALESCE(
    upload_generation,
    NULLIF(record ->> 'uploadGeneration', ''),
    'legacy:' || id
  )
WHERE upload_attempt_id IS NULL OR upload_generation IS NULL;
UPDATE reference_payload_references
SET record = jsonb_set(
  jsonb_set(
    record,
    '{uploadAttemptId}',
    to_jsonb(upload_attempt_id),
    true
  ),
  '{uploadGeneration}',
  to_jsonb(upload_generation),
  true
)
WHERE record ->> 'uploadAttemptId' IS DISTINCT FROM upload_attempt_id
   OR record ->> 'uploadGeneration' IS DISTINCT FROM upload_generation;
ALTER TABLE reference_payload_references
  ALTER COLUMN upload_attempt_id SET NOT NULL;
ALTER TABLE reference_payload_references
  ALTER COLUMN upload_generation SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reference_payload_reference_generation
  ON reference_payload_references(
    upload_attempt_id,
    upload_generation,
    object_key
  );

CREATE OR REPLACE FUNCTION reference_sync_payload_reference_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.upload_attempt_id IS NULL OR NEW.upload_generation IS NULL THEN
    RAISE EXCEPTION 'payload reference ownership is required';
  END IF;
  NEW.record := jsonb_set(
    jsonb_set(
      NEW.record,
      '{uploadAttemptId}',
      to_jsonb(NEW.upload_attempt_id),
      true
    ),
    '{uploadGeneration}',
    to_jsonb(NEW.upload_generation),
    true
  );
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS reference_payload_reference_ownership_sync
  ON reference_payload_references;
CREATE TRIGGER reference_payload_reference_ownership_sync
BEFORE INSERT OR UPDATE OF upload_attempt_id, upload_generation, record
ON reference_payload_references
FOR EACH ROW EXECUTE FUNCTION reference_sync_payload_reference_ownership();

ALTER TABLE reference_payload_cleanup_claims
  ADD COLUMN IF NOT EXISTS upload_generation text;
UPDATE reference_payload_cleanup_claims
SET
  upload_generation = COALESCE(
    upload_generation,
    NULLIF(record ->> 'uploadGeneration', ''),
    CASE
      WHEN upload_intent_id IS NULL THEN NULL
      ELSE 'legacy:' || upload_intent_id
    END
  ),
  record = CASE
    WHEN upload_intent_id IS NULL THEN record
    ELSE jsonb_set(
      record,
      '{uploadGeneration}',
      to_jsonb(
        COALESCE(
          NULLIF(record ->> 'uploadGeneration', ''),
          upload_generation,
          'legacy:' || upload_intent_id
        )
      ),
      true
    )
  END
WHERE upload_intent_id IS NOT NULL
  AND (
    upload_generation IS NULL
    OR NOT (record ? 'uploadGeneration')
  );

CREATE TABLE IF NOT EXISTS reference_release_summaries (
  release_id text PRIMARY KEY REFERENCES reference_releases(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_release_summaries_page
  ON reference_release_summaries(sequence DESC);

INSERT INTO reference_release_summaries(release_id, sequence, status, record)
SELECT
  release.id,
  release.sequence,
  CASE
    WHEN state.active_release_id = release.id THEN 'active'
    ELSE 'superseded'
  END,
  jsonb_build_object(
    'id', release.id,
    'importId', release.record ->> 'importId',
    'sequence', release.sequence,
    'checksum', release.record ->> 'checksum',
    'status', CASE
      WHEN state.active_release_id = release.id THEN 'active'
      ELSE 'superseded'
    END,
    'createdAt', release.record ->> 'createdAt',
    'compatibilityStatus', release.record #>> '{changelog,status}',
    'changeCount', jsonb_array_length(
      COALESCE(release.record #> '{changelog,changes}', '[]'::jsonb)
    ),
    'eventSummary', jsonb_build_object(
      'eventTypeCount', jsonb_array_length(
        COALESCE(release.record #> '{contract,eventTypes}', '[]'::jsonb)
      ),
      'eventVersionCount', COALESCE((
        SELECT SUM(jsonb_array_length(COALESCE(event -> 'versions', '[]'::jsonb)))
        FROM jsonb_array_elements(
          COALESCE(release.record #> '{contract,eventTypes}', '[]'::jsonb)
        ) AS event
      ), 0),
      'preview', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', event ->> 'id',
            'externalName', CASE
              WHEN char_length(event ->> 'externalName') <= 256
                THEN event ->> 'externalName'
              ELSE left(event ->> 'externalName', 255) || '…'
            END,
            'externalNameTruncated',
              char_length(event ->> 'externalName') > 256,
            'versionCount',
              jsonb_array_length(COALESCE(event -> 'versions', '[]'::jsonb))
          )
          ORDER BY ordinal
        )
        FROM jsonb_array_elements(
          COALESCE(release.record #> '{contract,eventTypes}', '[]'::jsonb)
        ) WITH ORDINALITY AS preview_event(event, ordinal)
        WHERE ordinal <= 20
      ), '[]'::jsonb),
      'truncated', jsonb_array_length(
        COALESCE(release.record #> '{contract,eventTypes}', '[]'::jsonb)
      ) > 20
    )
  )
FROM reference_releases AS release
CROSS JOIN reference_release_state AS state
WHERE state.singleton = true
ON CONFLICT(release_id) DO NOTHING;
`,
);
