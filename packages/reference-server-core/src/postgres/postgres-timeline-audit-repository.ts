// SPDX-License-Identifier: Apache-2.0

import {
  reduceDeliveryAttempt,
  type CanonicalMetadataRecord,
} from "@webhook-portal/adapter-sdk";
import { decodeTimelineCursor, encodeTimelineCursor } from "../cursor.js";
import { metadataTimelineIdentityKey } from "../crypto.js";
import { compareCodeUnits } from "../ordering.js";
import {
  PostgresRepositoryContext,
  asRecord,
  selectRecord,
  timelineEvidenceLockKeys,
  type JsonRecordRow,
} from "./postgres-repository-context.js";
import type {
  TimelineRepository,
  AuditOutboxRepository,
  AuditRecord,
  MetadataIngestSummary,
  OutboxRecord,
  TimelineEntry,
  TimelineEvidenceLockInput,
  TimelineFilters,
  TimelinePage,
} from "../types.js";

export class PostgresTimelineAuditRepository
  implements TimelineRepository, AuditOutboxRepository
{
  readonly #ctx: PostgresRepositoryContext;

  constructor(ctx: PostgresRepositoryContext) {
    this.#ctx = ctx;
  }

  async acquireTimelineEvidenceLocks(
    input: TimelineEvidenceLockInput,
  ): Promise<void> {
    const transaction = this.#ctx.currentTransaction();
    if (transaction === undefined) {
      throw new Error(
        "Timeline/evidence advisory locks require an active transaction.",
      );
    }
    const requiredLockKeys = timelineEvidenceLockKeys(input);
    if (transaction.timelineEvidenceLockKeys.size > 0) {
      const missingLockKeys = [...requiredLockKeys].filter(
        (lockKey) => !transaction.timelineEvidenceLockKeys.has(lockKey),
      );
      if (missingLockKeys.length > 0) {
        throw new Error(
          "Timeline/evidence advisory locks must be acquired together before repository reads or writes.",
        );
      }
      return;
    }
    const sortedLockKeys = [...requiredLockKeys].sort(compareCodeUnits);
    for (const lockKey of sortedLockKeys) {
      await transaction.client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );
      transaction.timelineEvidenceLockKeys.add(lockKey);
    }
  }

  async ingestMetadata(
    records: readonly CanonicalMetadataRecord[],
    ingestedAt: string,
  ): Promise<MetadataIngestSummary> {
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.fault("ingestMetadataBeforeLocks");
      const prepared = records.map((record) => ({
        record,
        identityKey: metadataTimelineIdentityKey(record),
      }));
      await this.#ctx.repository.acquireTimelineEvidenceLocks({ records });

      let accepted = 0;
      let duplicates = 0;
      let late = 0;
      for (const { identityKey, record } of prepared) {
        const endpoint = await this.#ctx.repository.lockEndpoint(
          record.endpointId,
        );
        if (endpoint?.state === "deleted") {
          throw new Error(
            "Metadata cannot be ingested for a deleted endpoint.",
          );
        }
        const current = await selectRecord<TimelineEntry>(
          this.#ctx.client(),
          `SELECT record
             FROM reference_metadata_timeline
             WHERE identity_key = $1
             FOR UPDATE`,
          [identityKey],
        );
        await this.#ctx.fault("ingestMetadataTimelineLocked");
        const isLate =
          current !== undefined &&
          (record.sequence < current.current.sequence ||
            record.occurredAt < current.current.occurredAt);
        const inserted = await this.#ctx.client().query(
          `INSERT INTO reference_metadata_observations(
               dedupe_key, identity_key, delivery_id, sequence,
               occurred_at, ingested_at, late, record
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
             ON CONFLICT(dedupe_key) DO NOTHING`,
          [
            record.dedupeKey,
            identityKey,
            record.deliveryId,
            record.sequence,
            record.occurredAt,
            ingestedAt,
            isLate,
            JSON.stringify(record),
          ],
        );
        if (inserted.rowCount === 0) {
          duplicates += 1;
          continue;
        }
        const reduction = reduceDeliveryAttempt(current?.reduction, record);
        const entry: TimelineEntry = {
          deliveryId: record.deliveryId,
          current: reduction.current,
          reduction,
          firstIngestedAt: current?.firstIngestedAt ?? ingestedAt,
          lastIngestedAt: ingestedAt,
          observationCount: (current?.observationCount ?? 0) + 1,
          lateObservationCount:
            (current?.lateObservationCount ?? 0) + (isLate ? 1 : 0),
          payloadRetained: current?.payloadRetained ?? false,
        };
        await this.#ctx.client().query(
          `INSERT INTO reference_metadata_timeline(
               identity_key, delivery_id, endpoint_id, event_id, event_type,
               status, occurred_at, last_ingested_at, record
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             ON CONFLICT(identity_key) DO UPDATE SET
               delivery_id = EXCLUDED.delivery_id,
               endpoint_id = EXCLUDED.endpoint_id,
               event_id = EXCLUDED.event_id,
               event_type = EXCLUDED.event_type,
               status = EXCLUDED.status,
               occurred_at = EXCLUDED.occurred_at,
               last_ingested_at = EXCLUDED.last_ingested_at,
               record = EXCLUDED.record`,
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
        accepted += 1;
        late += isLate ? 1 : 0;
        await this.#ctx.fault("ingestMetadataRecordProcessed");
      }
      return { accepted, duplicates, late };
    });
  }

  async listTimeline(filters: TimelineFilters): Promise<TimelinePage> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace("?", `$${values.length}`));
    };
    if (filters.deliveryId !== undefined) {
      add("delivery_id = ?", filters.deliveryId);
    }
    if (filters.endpointId !== undefined) {
      add("endpoint_id = ?", filters.endpointId);
    }
    if (filters.eventId !== undefined) {
      add("event_id = ?", filters.eventId);
    }
    if (filters.eventType !== undefined) {
      add("event_type = ?", filters.eventType);
    }
    if (filters.status !== undefined) {
      add("status = ?", filters.status);
    }
    if (filters.from !== undefined) {
      add("occurred_at >= ?", filters.from);
    }
    if (filters.to !== undefined) {
      add("occurred_at <= ?", filters.to);
    }
    if (filters.cursor !== undefined) {
      const cursor = decodeTimelineCursor(filters.cursor);
      values.push(cursor.lastIngestedAt, cursor.identityKey);
      conditions.push(
        `(last_ingested_at, identity_key) < ($${values.length - 1}, $${values.length})`,
      );
    }
    values.push(filters.limit + 1);
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const result = await this.#ctx.client().query<JsonRecordRow>(
      `SELECT record
         FROM reference_metadata_timeline
         ${where}
         ORDER BY last_ingested_at DESC, identity_key DESC
         LIMIT $${values.length}`,
      values,
    );
    const records = result.rows.map((row) =>
      asRecord<TimelineEntry>(row.record),
    );
    const hasMore = records.length > filters.limit;
    const items = records.slice(0, filters.limit);
    return {
      items,
      ...(hasMore && items.length > 0
        ? { nextCursor: encodeTimelineCursor(items[items.length - 1]!) }
        : {}),
    };
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.#ctx.client().query(
      `INSERT INTO reference_audit_events(
           id, created_at, action, resource_type, resource_id, result, record
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        record.id,
        record.createdAt,
        record.action,
        record.resourceType,
        record.resourceId ?? null,
        record.result,
        JSON.stringify(record),
      ],
    );
  }

  async listAudit(limit: number): Promise<readonly AuditRecord[]> {
    const result = await this.#ctx.client().query<JsonRecordRow>(
      `SELECT record
         FROM reference_audit_events
         ORDER BY created_at DESC, id DESC
         LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => asRecord<AuditRecord>(row.record));
  }

  async appendOutbox(record: OutboxRecord): Promise<void> {
    await this.#ctx.client().query(
      `INSERT INTO reference_outbox_events(
           id, created_at, topic, aggregate_type, aggregate_id,
           correlation_id, record
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        record.id,
        record.createdAt,
        record.topic,
        record.aggregateType,
        record.aggregateId ?? null,
        record.correlationId,
        JSON.stringify(record),
      ],
    );
  }

  async listOutbox(limit: number): Promise<readonly OutboxRecord[]> {
    const result = await this.#ctx.client().query<JsonRecordRow>(
      `SELECT record
         FROM reference_outbox_events
         ORDER BY created_at DESC, id DESC
         LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => asRecord<OutboxRecord>(row.record));
  }
}
