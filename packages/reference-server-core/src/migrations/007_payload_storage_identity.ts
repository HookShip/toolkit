// SPDX-License-Identifier: Apache-2.0

import { migration } from "./migration.js";

export const migration007PayloadStorageIdentity = migration(
  "007_payload_storage_identity",
  `
CREATE TABLE IF NOT EXISTS reference_payload_storage_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  namespace text NOT NULL UNIQUE CHECK (length(namespace) BETWEEN 16 AND 256),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
`,
);
