// SPDX-License-Identifier: Apache-2.0

import { referenceSha256 } from "../crypto.js";
import { PayloadCleanupConflictError } from "../repository-errors.js";
import {
  PostgresRepositoryContext,
  asRecord,
  selectRecord,
  sameJson,
  type JsonRecordRow,
} from "./postgres-repository-context.js";
import type {
  CreatePayloadReferenceInput,
  CreatePayloadUploadIntentInput,
  DeletePayloadReferenceInput,
  PayloadCleanupClaim,
  PayloadPage,
  PayloadReference,
  PayloadUploadIntent,
  TimelineEntry,
} from "../types.js";

export class PostgresPayloadReferenceRepository {
  readonly #ctx: PostgresRepositoryContext;

  constructor(ctx: PostgresRepositoryContext) {
    this.#ctx = ctx;
  }

  async createPayloadReference(
    input: CreatePayloadReferenceInput,
  ): Promise<void> {
    await this.#ctx.repository.transaction(async () => {
      await this.#ctx.lockPayloadObject(input.objectKey);
      const cleanupClaim = await selectRecord<PayloadCleanupClaim>(
        this.#ctx.client(),
        `SELECT record
           FROM reference_payload_cleanup_claims
           WHERE object_key = $1
           FOR UPDATE`,
        [input.objectKey],
      );
      if (
        cleanupClaim?.state === "deleting" ||
        cleanupClaim?.state === "deleted"
      ) {
        throw new PayloadCleanupConflictError(
          input.objectKey,
          cleanupClaim.state,
        );
      }
      const uploadIntent =
        await this.#ctx.repository.getPayloadUploadIntentByObjectKey(
          input.objectKey,
        );
      const hasUploadOwnership =
        input.uploadAttemptId !== undefined ||
        input.uploadGeneration !== undefined;
      if (
        hasUploadOwnership &&
        (input.uploadAttemptId === undefined ||
          input.uploadGeneration === undefined ||
          uploadIntent?.id !== input.uploadAttemptId ||
          uploadIntent.uploadAttemptId !== input.uploadAttemptId ||
          uploadIntent.uploadGeneration !== input.uploadGeneration)
      ) {
        throw new Error("Payload upload ownership does not match its intent.");
      }
      if (!hasUploadOwnership && uploadIntent !== undefined) {
        throw new Error("Payload upload ownership is required.");
      }
      if (cleanupClaim?.state === "claimed") {
        if (
          cleanupClaim.uploadIntentId !== input.uploadAttemptId ||
          cleanupClaim.uploadGeneration !== input.uploadGeneration
        ) {
          throw new Error(
            "Payload cleanup ownership does not match the upload.",
          );
        }
        await this.#ctx
          .client()
          .query(
            "DELETE FROM reference_payload_cleanup_claims WHERE object_key = $1",
            [input.objectKey],
          );
      }
      const inserted = await this.#ctx.client().query(
        `INSERT INTO reference_payload_references(
             id, object_key, upload_attempt_id, upload_generation,
             expires_at, delivery_id, endpoint_id, record
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT(id) DO NOTHING`,
        [
          input.id,
          input.objectKey,
          input.uploadAttemptId ?? null,
          input.uploadGeneration ?? null,
          input.expiresAt,
          input.deliveryId ?? null,
          input.endpointId ?? null,
          JSON.stringify(input),
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await this.getPayloadReference(input.id);
        if (existing === undefined || !sameJson(existing, input)) {
          throw new Error("A payload reference cannot be overwritten.");
        }
      }
      if (uploadIntent !== undefined) {
        await this.#ctx.client().query(
          `DELETE FROM reference_payload_upload_intents
             WHERE id = $1
               AND object_key = $2
               AND upload_generation = $3`,
          [
            uploadIntent.id,
            uploadIntent.objectKey,
            uploadIntent.uploadGeneration,
          ],
        );
      }
      if (input.deliveryId !== undefined) {
        const timelines = await this.#ctx
          .client()
          .query<JsonRecordRow & { readonly identity_key: string }>(
            `SELECT identity_key, record
             FROM reference_metadata_timeline
             WHERE delivery_id = $1
               AND ($2::text IS NULL OR endpoint_id = $2)
             FOR UPDATE`,
            [input.deliveryId, input.endpointId ?? null],
          );
        for (const row of timelines.rows) {
          const current = asRecord<TimelineEntry>(row.record);
          if (current.payloadRetained) {
            continue;
          }
          await this.#ctx.client().query(
            `UPDATE reference_metadata_timeline
               SET record = $2::jsonb
               WHERE identity_key = $1`,
            [
              row.identity_key,
              JSON.stringify({ ...current, payloadRetained: true }),
            ],
          );
        }
      }
    });
  }

  async getPayloadReference(id: string): Promise<PayloadReference | undefined> {
    return selectRecord<PayloadReference>(
      this.#ctx.client(),
      "SELECT record FROM reference_payload_references WHERE id = $1",
      [id],
    );
  }

  async getPayloadReferenceByObjectKey(
    objectKey: string,
  ): Promise<PayloadReference | undefined> {
    return selectRecord<PayloadReference>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_payload_references
         WHERE object_key = $1`,
      [objectKey],
    );
  }

  async listPayloadReferences(
    limit: number,
  ): Promise<readonly PayloadReference[]> {
    return (await this.listPayloadReferencesPage(limit)).items;
  }

  async listPayloadReferencesPage(
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>> {
    const result = await this.#ctx
      .client()
      .query<JsonRecordRow & { readonly id: string }>(
        `SELECT id, record
         FROM reference_payload_references
         WHERE ($2::text IS NULL OR id > $2)
         ORDER BY id
         LIMIT $1`,
        [limit + 1, cursor ?? null],
      );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => asRecord<PayloadReference>(row.record)),
      ...(result.rows.length > limit && rows.length > 0
        ? { nextCursor: rows[rows.length - 1]!.id }
        : {}),
    };
  }

  async listExpiredPayloadReferences(
    now: string,
    limit: number,
  ): Promise<readonly PayloadReference[]> {
    return (await this.listExpiredPayloadReferencesPage(now, limit)).items;
  }

  async listExpiredPayloadReferencesPage(
    now: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>> {
    const result = await this.#ctx
      .client()
      .query<JsonRecordRow & { readonly id: string }>(
        `SELECT id, record
         FROM reference_payload_references
         WHERE expires_at <= $1
           AND ($3::text IS NULL OR id > $3)
         ORDER BY id
         LIMIT $2`,
        [now, limit + 1, cursor ?? null],
      );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => asRecord<PayloadReference>(row.record)),
      ...(result.rows.length > limit && rows.length > 0
        ? { nextCursor: rows[rows.length - 1]!.id }
        : {}),
    };
  }

  async deletePayloadReference(
    input: DeletePayloadReferenceInput,
  ): Promise<void> {
    await this.#ctx.repository.transaction(async () => {
      await this.#ctx.lockPayloadObject(input.objectKey);
      const reference = await selectRecord<PayloadReference>(
        this.#ctx.client(),
        `SELECT record
           FROM reference_payload_references
           WHERE id = $1
           FOR UPDATE`,
        [input.id],
      );
      if (reference === undefined) {
        return;
      }
      if (
        reference.objectKey !== input.objectKey ||
        reference.uploadAttemptId !== input.uploadAttemptId ||
        reference.uploadGeneration !== input.uploadGeneration
      ) {
        throw new Error("Payload reference generation ownership was lost.");
      }
      const deleted = await this.#ctx.client().query(
        `DELETE FROM reference_payload_references
           WHERE id = $1
             AND object_key = $2
             AND upload_attempt_id IS NOT DISTINCT FROM $3
             AND upload_generation IS NOT DISTINCT FROM $4`,
        [
          input.id,
          input.objectKey,
          input.uploadAttemptId ?? null,
          input.uploadGeneration ?? null,
        ],
      );
      if (deleted.rowCount !== 1) {
        throw new Error("Payload reference generation ownership was lost.");
      }
      if (reference.deliveryId !== undefined) {
        const timelines = await this.#ctx
          .client()
          .query<JsonRecordRow & { readonly identity_key: string }>(
            `SELECT identity_key, record
             FROM reference_metadata_timeline
             WHERE delivery_id = $1
               AND ($2::text IS NULL OR endpoint_id = $2)
             FOR UPDATE`,
            [reference.deliveryId, reference.endpointId ?? null],
          );
        for (const row of timelines.rows) {
          const current = asRecord<TimelineEntry>(row.record);
          const remaining = await this.#ctx.client().query<{
            readonly count: string;
          }>(
            `SELECT COUNT(*)::text AS count
               FROM reference_payload_references
               WHERE delivery_id = $1
                 AND (endpoint_id IS NULL OR endpoint_id = $2)`,
            [reference.deliveryId, current.current.endpointId],
          );
          const retained = Number(remaining.rows[0]?.count ?? "0") > 0;
          await this.#ctx.client().query(
            `UPDATE reference_metadata_timeline
               SET record = $2::jsonb
               WHERE identity_key = $1`,
            [
              row.identity_key,
              JSON.stringify({ ...current, payloadRetained: retained }),
            ],
          );
        }
      }
    });
  }

  async createPayloadUploadIntent(
    input: CreatePayloadUploadIntentInput,
  ): Promise<PayloadUploadIntent> {
    return this.#ctx.repository.transaction(async () => {
      if (
        input.id !== input.uploadAttemptId ||
        input.uploadGeneration.length === 0
      ) {
        throw new Error("Payload upload attempt ownership is invalid.");
      }
      await this.#ctx.lockPayloadObject(input.objectKey);
      if (
        (await this.#ctx.repository.getPayloadReferenceByObjectKey(
          input.objectKey,
        )) !== undefined
      ) {
        throw new Error(
          "A referenced payload object key cannot start another upload.",
        );
      }
      const cleanupClaim = await selectRecord<PayloadCleanupClaim>(
        this.#ctx.client(),
        `SELECT record
           FROM reference_payload_cleanup_claims
           WHERE object_key = $1
           FOR UPDATE`,
        [input.objectKey],
      );
      if (cleanupClaim?.state === "claimed") {
        await this.#ctx
          .client()
          .query(
            "DELETE FROM reference_payload_cleanup_claims WHERE object_key = $1",
            [input.objectKey],
          );
      } else if (cleanupClaim?.state === "deleting") {
        throw new PayloadCleanupConflictError(input.objectKey, "deleting");
      } else if (cleanupClaim?.state === "deleted") {
        throw new PayloadCleanupConflictError(input.objectKey, "deleted");
      }
      const intent: PayloadUploadIntent = {
        ...input,
        state: "pending",
        updatedAt: input.createdAt,
        attempts: 0,
      };
      const inserted = await this.#ctx.client().query(
        `INSERT INTO reference_payload_upload_intents(
             id, object_key, upload_generation, endpoint_id, delivery_id, state,
             created_at, updated_at, attempts, record
           )
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6, 0, $7::jsonb)
           ON CONFLICT(id) DO NOTHING`,
        [
          intent.id,
          intent.objectKey,
          intent.uploadGeneration,
          intent.endpointId ?? null,
          intent.deliveryId ?? null,
          intent.createdAt,
          JSON.stringify(intent),
        ],
      );
      if (inserted.rowCount !== 0) {
        return intent;
      }
      const existing = await this.#ctx.repository.getPayloadUploadIntent(
        input.id,
      );
      if (existing === undefined) {
        throw new Error("A payload upload intent could not be created.");
      }
      const comparable: CreatePayloadUploadIntentInput = {
        id: existing.id,
        uploadAttemptId: existing.uploadAttemptId,
        uploadGeneration: existing.uploadGeneration,
        objectKey: existing.objectKey,
        contentType: existing.contentType,
        size: existing.size,
        createdAt: existing.createdAt,
        expiresAt: existing.expiresAt,
        ...(existing.endpointId === undefined
          ? {}
          : { endpointId: existing.endpointId }),
        ...(existing.deliveryId === undefined
          ? {}
          : { deliveryId: existing.deliveryId }),
      };
      if (!sameJson(comparable, input)) {
        throw new Error("A payload upload intent cannot be overwritten.");
      }
      return existing;
    });
  }

  async getPayloadUploadIntent(
    id: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return selectRecord<PayloadUploadIntent>(
      this.#ctx.client(),
      "SELECT record FROM reference_payload_upload_intents WHERE id = $1",
      [id],
    );
  }

  async getPayloadUploadIntentByObjectKey(
    objectKey: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return selectRecord<PayloadUploadIntent>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_payload_upload_intents
         WHERE object_key = $1`,
      [objectKey],
    );
  }

  async listPayloadUploadIntents(
    olderThan: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadUploadIntent>> {
    const result = await this.#ctx
      .client()
      .query<JsonRecordRow & { readonly id: string }>(
        `SELECT id, record
         FROM reference_payload_upload_intents
         WHERE created_at <= $1
           AND ($3::text IS NULL OR id > $3)
         ORDER BY id
         LIMIT $2`,
        [olderThan, limit + 1, cursor ?? null],
      );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => asRecord<PayloadUploadIntent>(row.record)),
      ...(result.rows.length > limit && rows.length > 0
        ? { nextCursor: rows[rows.length - 1]!.id }
        : {}),
    };
  }

  async markPayloadUploadIntentOrphaned(
    id: string,
    uploadGeneration: string,
    timestamp: string,
    errorCode: string,
  ): Promise<void> {
    const current = await selectRecord<PayloadUploadIntent>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_payload_upload_intents
         WHERE id = $1
         FOR UPDATE`,
      [id],
    );
    if (current === undefined) {
      return;
    }
    if (current.uploadGeneration !== uploadGeneration) {
      throw new Error("Payload upload generation ownership was lost.");
    }
    const next: PayloadUploadIntent = {
      ...current,
      state: "orphaned",
      attempts: current.attempts + 1,
      updatedAt: timestamp,
      lastErrorCode: referenceSha256(errorCode).slice(0, 16),
    };
    await this.#ctx.client().query(
      `UPDATE reference_payload_upload_intents
         SET state = 'orphaned',
             attempts = $2,
             last_error_code = $3,
             updated_at = $4,
             record = $5::jsonb
         WHERE id = $1 AND upload_generation = $6`,
      [
        id,
        next.attempts,
        next.lastErrorCode,
        timestamp,
        JSON.stringify(next),
        uploadGeneration,
      ],
    );
  }

  async completePayloadUploadIntent(
    id: string,
    uploadGeneration: string,
  ): Promise<void> {
    const deleted = await this.#ctx.client().query(
      `DELETE FROM reference_payload_upload_intents
         WHERE id = $1 AND upload_generation = $2`,
      [id, uploadGeneration],
    );
    if (
      deleted.rowCount === 0 &&
      (await this.#ctx.repository.getPayloadUploadIntent(id)) !== undefined
    ) {
      throw new Error("Payload upload generation ownership was lost.");
    }
  }
}
