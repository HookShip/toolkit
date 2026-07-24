// SPDX-License-Identifier: Apache-2.0

import {
  createAuthenticatedMetadataIngestEnvelope,
  type AuthenticatedMetadataIngestEnvelope,
  type MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";
import { createMetadataIngestVerifier } from "@webhook-portal/adapter-generic-http";

import { InvalidTimelineCursorError } from "./cursor.js";
import type { ReferenceServiceContext } from "./service-context.js";
import { ReferenceApiError } from "./service-support.js";
import type {
  AuditRecord,
  MetadataIngestSummary,
  TimelineFilters,
  TimelinePage,
} from "./types.js";

export class MetadataService {
  readonly #ctx: ReferenceServiceContext;

  constructor(ctx: ReferenceServiceContext) {
    this.#ctx = ctx;
  }

  createMetadataEnvelope(
    records: readonly MetadataDeliveryAttemptInput[],
    batchId: string,
  ): AuthenticatedMetadataIngestEnvelope {
    return createAuthenticatedMetadataIngestEnvelope(
      records,
      this.#ctx.config.metadataIdentity,
      batchId,
      this.#ctx.ingestCredential,
      { issuedAt: this.#ctx.nowMilliseconds() },
    );
  }

  async ingestMetadataEnvelope(
    envelope: unknown,
    correlationId: string,
  ): Promise<MetadataIngestSummary> {
    const verifier = createMetadataIngestVerifier({
      credential: this.#ctx.ingestCredential,
      identity: this.#ctx.config.metadataIdentity,
      clock: () => this.#ctx.nowMilliseconds(),
    });
    const verified = verifier.verify(envelope);
    if (!verified.ok) {
      await this.#ctx.audit({
        action: "metadata.ingest",
        resourceType: "metadata_batch",
        result: "denied",
        correlationId,
        details: { code: verified.code },
      });
      throw new ReferenceApiError(
        401,
        "INVALID_METADATA_SIGNATURE",
        "The metadata envelope could not be authenticated.",
      );
    }
    const summary = await this.#ctx.repository.ingestMetadata(
      verified.records,
      this.#ctx.nowIso(),
    );
    await this.#ctx.audit({
      action: "metadata.ingest",
      resourceType: "metadata_batch",
      resourceId: verified.envelope.batchId,
      result: "success",
      correlationId,
      details: {
        accepted: summary.accepted,
        duplicates: summary.duplicates,
        late: summary.late,
      },
    });
    return summary;
  }

  async listTimeline(
    filters: TimelineFilters,
    correlationId?: string,
  ): Promise<TimelinePage> {
    let page: TimelinePage;
    try {
      page = await this.#ctx.repository.listTimeline(filters);
    } catch (error) {
      if (error instanceof InvalidTimelineCursorError) {
        throw new ReferenceApiError(
          400,
          "INVALID_CURSOR",
          "The timeline cursor is invalid.",
        );
      }
      throw error;
    }
    if (correlationId !== undefined) {
      await this.#ctx.audit({
        action: "timeline.read",
        resourceType: "timeline",
        result: "success",
        correlationId,
        details: { resultCount: page.items.length },
      });
    }
    return page;
  }

  async listAudit(
    limit: number,
    correlationId?: string,
  ): Promise<readonly AuditRecord[]> {
    if (correlationId !== undefined) {
      await this.#ctx.audit({
        action: "audit.read",
        resourceType: "audit",
        result: "success",
        correlationId,
        details: { limit },
      });
    }
    return this.#ctx.repository.listAudit(limit);
  }
}
