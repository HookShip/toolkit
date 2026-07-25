// SPDX-License-Identifier: Apache-2.0

import {
  reduceDeliveryAttempt,
  type CanonicalMetadataRecord,
} from "@webhook-portal/adapter-sdk";
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  timelineEntryIsAfterCursor,
} from "../cursor.js";
import { metadataTimelineIdentityKey } from "../crypto.js";
import { compareCodeUnits } from "../ordering.js";
import { InMemoryRepositoryState, copy } from "./memory-repository-state.js";
import type {
  TimelineRepository,
  AuditOutboxRepository,
  AuditRecord,
  MetadataIngestSummary,
  OutboxRecord,
  TimelineEvidenceLockInput,
  TimelineFilters,
  TimelinePage,
} from "../types.js";

export class InMemoryTimelineAuditRepository
  implements TimelineRepository, AuditOutboxRepository
{
  readonly #ctx: InMemoryRepositoryState;

  constructor(ctx: InMemoryRepositoryState) {
    this.#ctx = ctx;
  }

  async acquireTimelineEvidenceLocks(
    input: TimelineEvidenceLockInput,
  ): Promise<void> {
    void input;
  }

  async ingestMetadata(
    records: readonly CanonicalMetadataRecord[],
    ingestedAt: string,
  ): Promise<MetadataIngestSummary> {
    return this.#ctx.repository.transaction(async () =>
      this.#ctx.withState(async (state) => {
        await this.#ctx.fault("ingestMetadata");
        let accepted = 0;
        let duplicates = 0;
        let late = 0;
        for (const record of records) {
          const endpoint = state.endpoints.get(record.endpointId);
          if (endpoint?.state === "deleted") {
            throw new Error(
              "Metadata cannot be ingested for a deleted endpoint.",
            );
          }
          if (state.metadataObservations.has(record.dedupeKey)) {
            duplicates += 1;
            continue;
          }
          const identityKey = metadataTimelineIdentityKey(record);
          const current = state.timeline.get(identityKey);
          const isLate =
            current !== undefined &&
            (record.sequence < current.current.sequence ||
              record.occurredAt < current.current.occurredAt);
          const reduction = reduceDeliveryAttempt(
            current?.reduction,
            copy(record),
          );
          state.metadataObservations.set(record.dedupeKey, {
            identityKey,
            record: copy(record),
          });
          state.timeline.set(identityKey, {
            deliveryId: record.deliveryId,
            current: copy(reduction.current),
            reduction: copy(reduction),
            firstIngestedAt: current?.firstIngestedAt ?? ingestedAt,
            lastIngestedAt: ingestedAt,
            observationCount: (current?.observationCount ?? 0) + 1,
            lateObservationCount:
              (current?.lateObservationCount ?? 0) + (isLate ? 1 : 0),
            payloadRetained: current?.payloadRetained ?? false,
          });
          accepted += 1;
          late += isLate ? 1 : 0;
        }
        return { accepted, duplicates, late };
      }),
    );
  }

  async listTimeline(filters: TimelineFilters): Promise<TimelinePage> {
    return this.#ctx.withState(async (state) => {
      const cursor =
        filters.cursor === undefined
          ? undefined
          : decodeTimelineCursor(filters.cursor);
      const items = [...state.timeline.values()]
        .filter((entry) => {
          const record = entry.current;
          return (
            (filters.deliveryId === undefined ||
              entry.deliveryId === filters.deliveryId) &&
            (filters.endpointId === undefined ||
              record.endpointId === filters.endpointId) &&
            (filters.eventId === undefined ||
              record.eventId === filters.eventId) &&
            (filters.eventType === undefined ||
              record.eventVersion.eventType === filters.eventType) &&
            (filters.status === undefined ||
              record.status === filters.status) &&
            (filters.from === undefined || record.occurredAt >= filters.from) &&
            (filters.to === undefined || record.occurredAt <= filters.to) &&
            (cursor === undefined || timelineEntryIsAfterCursor(entry, cursor))
          );
        })
        .sort((left, right) => {
          const time = compareCodeUnits(
            right.lastIngestedAt,
            left.lastIngestedAt,
          );
          return time === 0
            ? compareCodeUnits(
                metadataTimelineIdentityKey(right.current),
                metadataTimelineIdentityKey(left.current),
              )
            : time;
        });
      const page = items.slice(0, filters.limit).map(copy);
      const hasMore = filters.limit < items.length;
      return {
        items: page,
        ...(hasMore && page.length > 0
          ? { nextCursor: encodeTimelineCursor(page[page.length - 1]!) }
          : {}),
      };
    });
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("appendAudit");
      if (state.audit.some((existing) => existing.id === record.id)) {
        throw new Error(`Audit event "${record.id}" already exists.`);
      }
      state.audit.push(copy(record));
    });
  }

  async listAudit(limit: number): Promise<readonly AuditRecord[]> {
    return this.#ctx.withState(async (state) =>
      state.audit.slice(-limit).reverse().map(copy),
    );
  }

  async appendOutbox(record: OutboxRecord): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("appendOutbox");
      if (state.outbox.some((existing) => existing.id === record.id)) {
        throw new Error(`Outbox event "${record.id}" already exists.`);
      }
      state.outbox.push(copy(record));
    });
  }

  async listOutbox(limit: number): Promise<readonly OutboxRecord[]> {
    return this.#ctx.withState(async (state) =>
      state.outbox.slice(-limit).reverse().map(copy),
    );
  }
}
