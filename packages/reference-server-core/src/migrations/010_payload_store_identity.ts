// SPDX-License-Identifier: Apache-2.0

import { migration } from "./migration.js";

export const migration010PayloadStoreIdentity = migration(
  "010_payload_store_identity",
  `
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
`,
);
