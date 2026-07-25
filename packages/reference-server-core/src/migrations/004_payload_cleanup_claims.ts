// SPDX-License-Identifier: Apache-2.0

import { migration } from "./migration.js";

export const migration004PayloadCleanupClaims = migration(
  "004_payload_cleanup_claims",
  `
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
`,
);
