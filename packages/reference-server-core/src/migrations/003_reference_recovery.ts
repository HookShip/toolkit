// SPDX-License-Identifier: Apache-2.0

import { migration } from "./migration.js";

export const migration003ReferenceRecovery = migration(
  "003_reference_recovery",
  `
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
`,
);
