// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  reduceDeliveryAttempt,
  type CanonicalMetadataRecord,
  type DeliveryAttemptReduction,
} from "@webhook-portal/adapter-sdk";
import type { Pool, PoolClient } from "pg";

import { metadataTimelineIdentityKey } from "./crypto.js";
import type { TimelineEntry } from "./types.js";

export interface SqlMigration {
  readonly version: string;
  readonly checksum: string;
  readonly sql: string;
  readonly run?: (
    client: PoolClient,
    context: MigrationExecutionContext,
  ) => Promise<void>;
}

export interface MigrationExecutionContext {
  readonly onTimelineTablesLocked?: () => Promise<void> | void;
}

export type MigratePostgresOptions = MigrationExecutionContext;

function migration(
  version: string,
  sql: string,
  run?: (
    client: PoolClient,
    context: MigrationExecutionContext,
  ) => Promise<void>,
  runChecksum = "",
): SqlMigration {
  return Object.freeze({
    version,
    sql,
    checksum: createHash("sha256")
      .update(
        runChecksum.length === 0 ? sql.trim() : `${sql.trim()}\n${runChecksum}`,
      )
      .digest("hex"),
    ...(run === undefined ? {} : { run }),
  });
}

export const EXPECTED_REFERENCE_SCHEMA_VERSION = "011_store_derived_bucket";
const REFERENCE_CHECKSUM_MIGRATION_VERSION = "003_reference_recovery";

function isoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function migrateLegacyTimelineIdentity(
  client: PoolClient,
  context: MigrationExecutionContext,
): Promise<void> {
  await client.query(
    `LOCK TABLE reference_metadata_timeline
     IN ACCESS EXCLUSIVE MODE`,
  );
  await client.query(
    `LOCK TABLE reference_metadata_observations
     IN ACCESS EXCLUSIVE MODE`,
  );
  await context.onTimelineTablesLocked?.();
  const observations = await client.query<{
    readonly dedupe_key: string;
    readonly identity_key: string;
    readonly ingested_at: string | Date;
    readonly late: boolean;
    readonly record: unknown;
  }>(
    `SELECT dedupe_key, identity_key, ingested_at, late, record
     FROM reference_metadata_observations
     ORDER BY ingested_at, dedupe_key
     FOR UPDATE`,
  );
  const timelines = await client.query<{
    readonly identity_key: string;
    readonly record: unknown;
  }>(
    `SELECT identity_key, record
     FROM reference_metadata_timeline
     FOR UPDATE`,
  );
  const timelineRows = timelines.rows.map((row) => {
    const entry = row.record as TimelineEntry;
    try {
      return {
        key: metadataTimelineIdentityKey(entry.current),
        entry,
      };
    } catch {
      throw new Error(
        "Legacy metadata timeline identity could not be reconstructed.",
      );
    }
  });
  const payloadRetained = new Map<string, boolean>();
  for (const row of timelineRows) {
    payloadRetained.set(
      row.key,
      (payloadRetained.get(row.key) ?? false) || row.entry.payloadRetained,
    );
  }
  const groups = new Map<
    string,
    Array<{
      readonly dedupeKey: string;
      readonly ingestedAt: string;
      readonly late: boolean;
      readonly record: CanonicalMetadataRecord;
    }>
  >();
  for (const row of observations.rows) {
    const record = row.record as CanonicalMetadataRecord;
    let key: string;
    try {
      key = metadataTimelineIdentityKey(record);
    } catch {
      throw new Error(
        "Legacy metadata observation identity could not be reconstructed.",
      );
    }
    const entries = groups.get(key) ?? [];
    entries.push({
      dedupeKey: row.dedupe_key,
      ingestedAt: isoTimestamp(row.ingested_at),
      late: row.late,
      record,
    });
    groups.set(key, entries);
    if (row.identity_key !== key) {
      await client.query(
        `UPDATE reference_metadata_observations
         SET identity_key = $2
         WHERE dedupe_key = $1`,
        [row.dedupe_key, key],
      );
    }
  }
  const merged = new Map<string, TimelineEntry>();
  for (const [key, entries] of groups) {
    entries.sort((left, right) => {
      if (left.ingestedAt !== right.ingestedAt) {
        return left.ingestedAt < right.ingestedAt ? -1 : 1;
      }
      return left.dedupeKey < right.dedupeKey
        ? -1
        : left.dedupeKey > right.dedupeKey
          ? 1
          : 0;
    });
    let reduction: DeliveryAttemptReduction | undefined;
    for (const entry of entries) {
      reduction = reduceDeliveryAttempt(reduction, entry.record);
    }
    const finalReduction = reduction;
    if (finalReduction === undefined) {
      continue;
    }
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;
    merged.set(key, {
      deliveryId: finalReduction.current.deliveryId,
      current: finalReduction.current,
      reduction: finalReduction,
      firstIngestedAt: first.ingestedAt,
      lastIngestedAt: last.ingestedAt,
      observationCount: entries.length,
      lateObservationCount: entries.filter((entry) => entry.late).length,
      payloadRetained: payloadRetained.get(key) ?? false,
    });
  }
  for (const row of timelineRows) {
    if (groups.has(row.key)) {
      continue;
    }
    const current = merged.get(row.key);
    const reduction = reduceDeliveryAttempt(
      current?.reduction,
      row.entry.current,
    );
    merged.set(row.key, {
      deliveryId: reduction.current.deliveryId,
      current: reduction.current,
      reduction,
      firstIngestedAt:
        current === undefined ||
        row.entry.firstIngestedAt < current.firstIngestedAt
          ? row.entry.firstIngestedAt
          : current.firstIngestedAt,
      lastIngestedAt:
        current === undefined ||
        row.entry.lastIngestedAt > current.lastIngestedAt
          ? row.entry.lastIngestedAt
          : current.lastIngestedAt,
      observationCount:
        (current?.observationCount ?? 0) + row.entry.observationCount,
      lateObservationCount:
        (current?.lateObservationCount ?? 0) + row.entry.lateObservationCount,
      payloadRetained:
        (current?.payloadRetained ?? false) || row.entry.payloadRetained,
    });
  }
  await client.query("DELETE FROM reference_metadata_timeline");
  for (const [identityKey, entry] of merged) {
    await client.query(
      `INSERT INTO reference_metadata_timeline(
         identity_key, delivery_id, endpoint_id, event_id, event_type, status,
         occurred_at, last_ingested_at, record
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        identityKey,
        entry.deliveryId,
        entry.current.endpointId,
        entry.current.eventId,
        entry.current.eventVersion.eventType,
        entry.current.status,
        entry.current.occurredAt,
        entry.lastIngestedAt,
        JSON.stringify(entry),
      ],
    );
  }
}

export const REFERENCE_SERVER_MIGRATIONS: readonly SqlMigration[] =
  Object.freeze([
    migration(
      "001_initial",
      `
CREATE TABLE IF NOT EXISTS reference_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_contract_imports (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_releases (
  id text PRIMARY KEY,
  sequence bigint NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_releases_one_active
  ON reference_releases (active) WHERE active;

CREATE TABLE IF NOT EXISTS reference_endpoints (
  id text PRIMARY KEY,
  state text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_subscriptions (
  endpoint_id text PRIMARY KEY REFERENCES reference_endpoints(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_secret_versions (
  id text PRIMARY KEY,
  endpoint_id text NOT NULL REFERENCES reference_endpoints(id) ON DELETE CASCADE,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_secret_versions_endpoint
  ON reference_secret_versions(endpoint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reference_test_commands (
  id text PRIMARY KEY,
  endpoint_id text NOT NULL REFERENCES reference_endpoints(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  UNIQUE(endpoint_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS reference_metadata_observations (
  dedupe_key text PRIMARY KEY,
  delivery_id text NOT NULL,
  sequence integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  late boolean NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_metadata_observations_delivery
  ON reference_metadata_observations(delivery_id, ingested_at);

CREATE TABLE IF NOT EXISTS reference_metadata_timeline (
  delivery_id text PRIMARY KEY,
  endpoint_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  last_ingested_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_metadata_timeline_search
  ON reference_metadata_timeline(last_ingested_at DESC, delivery_id DESC);
CREATE INDEX IF NOT EXISTS reference_metadata_timeline_filters
  ON reference_metadata_timeline(endpoint_id, event_type, status, occurred_at DESC);

CREATE TABLE IF NOT EXISTS reference_audit_events (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  result text NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_audit_events_created
  ON reference_audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS reference_payload_references (
  id text PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  delivery_id text,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_payload_references_expiry
  ON reference_payload_references(expires_at);
`,
    ),
    migration(
      "002_persistence_hardening",
      `
CREATE TABLE IF NOT EXISTS reference_release_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_release_id text REFERENCES reference_releases(id) ON DELETE RESTRICT,
  next_sequence bigint NOT NULL CHECK (next_sequence > 0)
);
INSERT INTO reference_release_state(singleton, active_release_id, next_sequence)
SELECT
  true,
  (SELECT id FROM reference_releases WHERE active ORDER BY sequence DESC LIMIT 1),
  COALESCE((SELECT MAX(sequence) + 1 FROM reference_releases), 1)
ON CONFLICT(singleton) DO UPDATE SET
  active_release_id = COALESCE(
    reference_release_state.active_release_id,
    EXCLUDED.active_release_id
  ),
  next_sequence = GREATEST(
    reference_release_state.next_sequence,
    EXCLUDED.next_sequence
  );
DROP TRIGGER IF EXISTS reference_release_immutable_guard
  ON reference_releases;
UPDATE reference_releases SET active = false WHERE active;

CREATE TABLE IF NOT EXISTS reference_publish_commands (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  import_id text NOT NULL REFERENCES reference_contract_imports(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('requested', 'completed')),
  release_id text REFERENCES reference_releases(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_outbox_events (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text,
  correlation_id text NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_outbox_events_created
  ON reference_outbox_events(created_at, id);

ALTER TABLE reference_metadata_observations
  ADD COLUMN IF NOT EXISTS identity_key text;
UPDATE reference_metadata_observations
SET identity_key = 'legacy:' || delivery_id
WHERE identity_key IS NULL;
ALTER TABLE reference_metadata_observations
  ALTER COLUMN identity_key SET NOT NULL;
CREATE INDEX IF NOT EXISTS reference_metadata_observations_identity
  ON reference_metadata_observations(identity_key, ingested_at);

ALTER TABLE reference_metadata_timeline
  ADD COLUMN IF NOT EXISTS identity_key text;
UPDATE reference_metadata_timeline
SET identity_key = 'legacy:' || delivery_id
WHERE identity_key IS NULL;
ALTER TABLE reference_metadata_timeline
  ALTER COLUMN identity_key SET NOT NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'reference_metadata_timeline'::regclass
      AND conname = 'reference_metadata_timeline_pkey'
  ) THEN
    ALTER TABLE reference_metadata_timeline
      DROP CONSTRAINT reference_metadata_timeline_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'reference_metadata_timeline'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE reference_metadata_timeline
      ADD CONSTRAINT reference_metadata_timeline_identity_pkey
      PRIMARY KEY(identity_key);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS reference_metadata_timeline_delivery
  ON reference_metadata_timeline(delivery_id);

ALTER TABLE reference_payload_references
  ADD COLUMN IF NOT EXISTS endpoint_id text;
UPDATE reference_payload_references
SET endpoint_id = NULLIF(record ->> 'endpointId', '')
WHERE endpoint_id IS NULL;
UPDATE reference_payload_references AS payload
SET endpoint_id = timeline.endpoint_id
FROM reference_metadata_timeline AS timeline
WHERE payload.endpoint_id IS NULL
  AND payload.delivery_id = timeline.delivery_id;
CREATE INDEX IF NOT EXISTS reference_payload_references_endpoint
  ON reference_payload_references(endpoint_id);

CREATE TABLE IF NOT EXISTS reference_payload_cleanup_tasks (
  id text PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  endpoint_id text REFERENCES reference_endpoints(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('pending', 'failed')),
  reason text NOT NULL CHECK (reason IN ('endpoint_deleted', 'expired', 'orphaned')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_payload_cleanup_tasks_pending
  ON reference_payload_cleanup_tasks(state, created_at);

DROP TRIGGER IF EXISTS reference_endpoint_tombstone_guard
  ON reference_endpoints;
INSERT INTO reference_payload_cleanup_tasks(
  id,
  object_key,
  endpoint_id,
  state,
  reason,
  created_at,
  updated_at,
  attempts,
  record
)
SELECT
  'endpoint:' || payload.id,
  payload.object_key,
  endpoint.id,
  'pending',
  'endpoint_deleted',
  endpoint.updated_at,
  endpoint.updated_at,
  0,
  jsonb_build_object(
    'id', 'endpoint:' || payload.id,
    'objectKey', payload.object_key,
    'endpointId', endpoint.id,
    'state', 'pending',
    'reason', 'endpoint_deleted',
    'createdAt', endpoint.updated_at,
    'updatedAt', endpoint.updated_at,
    'attempts', 0
  )
FROM reference_payload_references AS payload
JOIN reference_endpoints AS endpoint
  ON endpoint.id = payload.endpoint_id
WHERE endpoint.state = 'deleted'
ON CONFLICT(id) DO NOTHING;

DELETE FROM reference_payload_references AS payload
USING reference_endpoints AS endpoint
WHERE endpoint.id = payload.endpoint_id
  AND endpoint.state = 'deleted';
DELETE FROM reference_metadata_observations AS observation
USING reference_metadata_timeline AS timeline,
      reference_endpoints AS endpoint
WHERE observation.identity_key = timeline.identity_key
  AND timeline.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';
DELETE FROM reference_metadata_timeline AS timeline
USING reference_endpoints AS endpoint
WHERE timeline.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';
DELETE FROM reference_subscriptions AS subscription
USING reference_endpoints AS endpoint
WHERE subscription.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';
DELETE FROM reference_secret_versions AS secret
USING reference_endpoints AS endpoint
WHERE secret.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';
DELETE FROM reference_test_commands AS command
USING reference_endpoints AS endpoint
WHERE command.endpoint_id = endpoint.id
  AND endpoint.state = 'deleted';

ALTER TABLE reference_endpoints
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE reference_endpoints
  ALTER COLUMN url DROP NOT NULL;
UPDATE reference_endpoints
SET
  url = NULL,
  deleted_at = COALESCE(deleted_at, updated_at),
  record = jsonb_build_object(
    'id', id,
    'createdAt', created_at,
    'updatedAt', updated_at,
    'deletedAt', COALESCE(deleted_at, updated_at),
    'state', 'deleted',
    'tombstoneVersion', 1
  )
WHERE state = 'deleted';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reference_endpoints'::regclass
      AND conname = 'reference_endpoints_state_check'
  ) THEN
    ALTER TABLE reference_endpoints
      ADD CONSTRAINT reference_endpoints_state_check
      CHECK (state IN ('active', 'paused', 'deleted'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reference_endpoints'::regclass
      AND conname = 'reference_endpoints_tombstone_check'
  ) THEN
    ALTER TABLE reference_endpoints
      ADD CONSTRAINT reference_endpoints_tombstone_check
      CHECK (
        (
          state = 'deleted'
          AND url IS NULL
          AND deleted_at IS NOT NULL
          AND NOT (record ? 'url')
          AND NOT (record ? 'description')
          AND NOT (record ? 'allowLocalNetwork')
        )
        OR
        (
          state IN ('active', 'paused')
          AND url IS NOT NULL
          AND deleted_at IS NULL
        )
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION reference_guard_endpoint_tombstone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reference endpoint tombstones cannot be deleted';
  END IF;
  IF OLD.state = 'deleted' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'reference endpoint tombstones are immutable';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS reference_endpoint_tombstone_guard
  ON reference_endpoints;
CREATE TRIGGER reference_endpoint_tombstone_guard
BEFORE UPDATE OR DELETE ON reference_endpoints
FOR EACH ROW EXECUTE FUNCTION reference_guard_endpoint_tombstone();

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY endpoint_id
      ORDER BY created_at DESC, id DESC
    ) AS active_rank
  FROM reference_secret_versions
  WHERE state = 'active'
),
revoked AS (
  UPDATE reference_secret_versions AS secret
  SET
    state = 'revoked',
    updated_at = now(),
    record = jsonb_set(
      jsonb_set(secret.record, '{state}', to_jsonb('revoked'::text), true),
      '{updatedAt}',
      to_jsonb(now()::text),
      true
    )
  FROM ranked
  WHERE ranked.id = secret.id
    AND ranked.active_rank > 1
  RETURNING secret.id, secret.endpoint_id, secret.updated_at
)
INSERT INTO reference_audit_events(
  id,
  created_at,
  action,
  resource_type,
  resource_id,
  result,
  record
)
SELECT
  'migration-002-secret-' || id,
  updated_at,
  'secret.migration_revoke_duplicate',
  'secret_version',
  id,
  'success',
  jsonb_build_object(
    'id', 'migration-002-secret-' || id,
    'createdAt', updated_at,
    'action', 'secret.migration_revoke_duplicate',
    'resourceType', 'secret_version',
    'resourceId', id,
    'result', 'success',
    'actorId', 'schema-migration',
    'correlationId', '002_persistence_hardening',
    'details', jsonb_build_object('endpointId', endpoint_id)
  )
FROM revoked
ON CONFLICT(id) DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS reference_secret_versions_one_active
  ON reference_secret_versions(endpoint_id)
  WHERE state = 'active';

CREATE OR REPLACE FUNCTION reference_guard_release_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reference releases are immutable';
END
$$;
DROP TRIGGER IF EXISTS reference_release_immutable_guard
  ON reference_releases;
CREATE TRIGGER reference_release_immutable_guard
BEFORE UPDATE OR DELETE ON reference_releases
FOR EACH ROW EXECUTE FUNCTION reference_guard_release_immutability();
`,
    ),
    migration(
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
    ),
    migration(
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
    ),
    migration(
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
    ),
    migration(
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
    ),
    migration(
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
    ),
    migration(
      "008_namespace_binding_timeline_identity",
      `
ALTER TABLE reference_payload_storage_state
  ADD COLUMN IF NOT EXISTS status text;
UPDATE reference_payload_storage_state
SET
  status = COALESCE(status, 'ready'),
  record = jsonb_set(
    record,
    '{status}',
    to_jsonb(COALESCE(status, 'ready')),
    true
  )
WHERE status IS NULL OR NOT (record ? 'status');
ALTER TABLE reference_payload_storage_state
  ALTER COLUMN status SET NOT NULL;
ALTER TABLE reference_payload_storage_state
  DROP CONSTRAINT IF EXISTS reference_payload_storage_state_status_check;
ALTER TABLE reference_payload_storage_state
  ADD CONSTRAINT reference_payload_storage_state_status_check
  CHECK (status IN ('binding', 'ready'));
`,
      migrateLegacyTimelineIdentity,
      "metadata-timeline-identity-v4-timeline-before-observations",
    ),
    migration(
      "009_namespace_derived_bucket",
      `
ALTER TABLE reference_payload_storage_state
  DROP CONSTRAINT IF EXISTS reference_payload_storage_state_namespace_check;
ALTER TABLE reference_payload_storage_state
  ADD CONSTRAINT reference_payload_storage_state_namespace_check
  CHECK (namespace ~ '^[0-9a-f]{32}$') NOT VALID;
`,
    ),
    migration(
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
    ),
    migration(
      EXPECTED_REFERENCE_SCHEMA_VERSION,
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
    ),
  ]);

interface MigrationRow {
  readonly version: string;
  readonly checksum: string | null;
}

export interface MigrationStateProblem {
  readonly missingVersions: readonly string[];
  readonly unexpectedVersions: readonly string[];
  readonly checksumMismatches: readonly {
    readonly version: string;
    readonly expectedChecksum?: string;
    readonly actualChecksum?: string;
  }[];
}

export class MigrationStateError extends Error {
  readonly code = "REFERENCE_MIGRATION_STATE_INVALID";
  readonly problem: MigrationStateProblem;

  constructor(problem: MigrationStateProblem) {
    super("The reference database migration state is not safe to modify.");
    this.name = "MigrationStateError";
    this.problem = problem;
  }
}

export function expectedReferenceMigrationChecksums(): ReadonlyMap<
  string,
  string
> {
  return new Map(
    REFERENCE_SERVER_MIGRATIONS.map((entry) => [entry.version, entry.checksum]),
  );
}

async function prepareMigrationTable(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS reference_schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
  await client.query(
    `ALTER TABLE reference_schema_migrations
     ADD COLUMN IF NOT EXISTS checksum text`,
  );
  const expected = expectedReferenceMigrationChecksums();
  const existing = await client.query<MigrationRow>(
    "SELECT version, checksum FROM reference_schema_migrations",
  );
  const checksumMigrationApplied = existing.rows.some(
    (row) => row.version === REFERENCE_CHECKSUM_MIGRATION_VERSION,
  );
  for (const row of existing.rows) {
    const expectedChecksum = expected.get(row.version);
    if (
      checksumMigrationApplied ||
      row.checksum !== null ||
      expectedChecksum === undefined
    ) {
      continue;
    }
    await client.query(
      `UPDATE reference_schema_migrations
       SET checksum = $2
       WHERE version = $1 AND checksum IS NULL`,
      [row.version, expectedChecksum],
    );
  }
}

async function assertSafeMigrationState(client: PoolClient): Promise<void> {
  const expected = expectedReferenceMigrationChecksums();
  const result = await client.query<MigrationRow>(
    "SELECT version, checksum FROM reference_schema_migrations ORDER BY version",
  );
  const unexpectedVersions: string[] = [];
  const checksumMismatches: MigrationStateProblem["checksumMismatches"][number][] =
    [];
  const appliedVersions = new Set(result.rows.map((row) => row.version));
  const firstMissingIndex = REFERENCE_SERVER_MIGRATIONS.findIndex(
    (entry) => !appliedVersions.has(entry.version),
  );
  const missingVersions =
    firstMissingIndex < 0 ||
    !REFERENCE_SERVER_MIGRATIONS.slice(firstMissingIndex + 1).some((entry) =>
      appliedVersions.has(entry.version),
    )
      ? []
      : REFERENCE_SERVER_MIGRATIONS.slice(firstMissingIndex)
          .filter((entry) => !appliedVersions.has(entry.version))
          .map((entry) => entry.version);
  for (const row of result.rows) {
    const expectedChecksum = expected.get(row.version);
    if (expectedChecksum === undefined) {
      unexpectedVersions.push(row.version);
      continue;
    }
    if (row.checksum !== expectedChecksum) {
      checksumMismatches.push({
        version: row.version,
        expectedChecksum,
        ...(row.checksum === null ? {} : { actualChecksum: row.checksum }),
      });
    }
  }
  if (
    missingVersions.length > 0 ||
    unexpectedVersions.length > 0 ||
    checksumMismatches.length > 0
  ) {
    throw new MigrationStateError({
      missingVersions,
      unexpectedVersions,
      checksumMismatches,
    });
  }
}

async function applyMigration(
  client: PoolClient,
  entry: SqlMigration,
  context: MigrationExecutionContext,
): Promise<boolean> {
  const existing = await client.query<MigrationRow>(
    `SELECT version, checksum
     FROM reference_schema_migrations
     WHERE version = $1`,
    [entry.version],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    if (row.checksum !== entry.checksum) {
      throw new MigrationStateError({
        missingVersions: [],
        unexpectedVersions: [],
        checksumMismatches: [
          {
            version: entry.version,
            expectedChecksum: entry.checksum,
            ...(row.checksum === null ? {} : { actualChecksum: row.checksum }),
          },
        ],
      });
    }
    return false;
  }
  await client.query(entry.sql);
  await entry.run?.(client, context);
  await client.query(
    `INSERT INTO reference_schema_migrations(version, checksum)
     VALUES ($1, $2)`,
    [entry.version, entry.checksum],
  );
  return true;
}

export async function migratePostgres(
  pool: Pool,
  options: MigratePostgresOptions = {},
): Promise<readonly string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('webhook-portal-reference-migrations', 0))",
    );
    await prepareMigrationTable(client);
    await assertSafeMigrationState(client);
    for (const entry of REFERENCE_SERVER_MIGRATIONS) {
      if (await applyMigration(client, entry, options)) {
        applied.push(entry.version);
      }
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      destroyClient = true;
      throw new AggregateError(
        [error, rollbackError],
        "Reference migration failed and rollback could not be confirmed.",
      );
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
