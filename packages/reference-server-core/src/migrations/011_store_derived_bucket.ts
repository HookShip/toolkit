// SPDX-License-Identifier: Apache-2.0

import { migration } from "./migration.js";

export const migration011StoreDerivedBucket = migration(
  "011_store_derived_bucket",
  `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM reference_payload_storage_state
    WHERE
      namespace !~ '^[0-9a-f]{22}$'
      OR store_id IS NULL
      OR store_id !~ '^[0-9a-f]{22}$'
      OR store_id = namespace
  ) THEN
    RAISE EXCEPTION
      'Legacy payload storage identity requires a pre-release reset before migration 011.';
  END IF;
END
$$;

ALTER TABLE reference_payload_storage_state
  DROP CONSTRAINT IF EXISTS reference_payload_storage_state_namespace_check;
ALTER TABLE reference_payload_storage_state
  ADD CONSTRAINT reference_payload_storage_state_namespace_check
  CHECK (namespace ~ '^[0-9a-f]{22}$') NOT VALID;
ALTER TABLE reference_payload_storage_state
  VALIDATE CONSTRAINT reference_payload_storage_state_namespace_check;

ALTER TABLE reference_payload_storage_state
  DROP CONSTRAINT IF EXISTS reference_payload_storage_state_store_id_check;
ALTER TABLE reference_payload_storage_state
  ADD CONSTRAINT reference_payload_storage_state_store_id_check
  CHECK (
    store_id IS NULL
    OR (
      store_id ~ '^[0-9a-f]{22}$'
      AND store_id <> namespace
    )
  ) NOT VALID;
ALTER TABLE reference_payload_storage_state
  VALIDATE CONSTRAINT reference_payload_storage_state_store_id_check;
`,
);
