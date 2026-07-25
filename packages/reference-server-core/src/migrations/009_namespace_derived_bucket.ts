// SPDX-License-Identifier: Apache-2.0

import { migration } from "./migration.js";

export const migration009NamespaceDerivedBucket = migration(
  "009_namespace_derived_bucket",
  `
ALTER TABLE reference_payload_storage_state
  DROP CONSTRAINT IF EXISTS reference_payload_storage_state_namespace_check;
ALTER TABLE reference_payload_storage_state
  ADD CONSTRAINT reference_payload_storage_state_namespace_check
  CHECK (namespace ~ '^[0-9a-f]{32}$') NOT VALID;
`,
);
