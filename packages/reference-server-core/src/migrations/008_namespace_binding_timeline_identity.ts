// SPDX-License-Identifier: Apache-2.0

import {
  reduceDeliveryAttempt,
  type CanonicalMetadataRecord,
  type DeliveryAttemptReduction,
} from "@webhook-portal/adapter-sdk";
import type { PoolClient } from "pg";

import { metadataTimelineIdentityKey } from "../crypto.js";
import type { TimelineEntry } from "../types.js";
import { migration, type MigrationExecutionContext } from "./migration.js";

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

export const migration008NamespaceBindingTimelineIdentity = migration(
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
);
