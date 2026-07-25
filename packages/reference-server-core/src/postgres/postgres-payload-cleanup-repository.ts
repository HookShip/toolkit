// SPDX-License-Identifier: Apache-2.0

import { referenceSha256 } from "../crypto.js";
import {
  PostgresRepositoryContext,
  asRecord,
  selectRecord,
  type JsonRecordRow,
} from "./postgres-repository-context.js";
import type {
  BeginPayloadCleanupDeletionInput,
  BeginPayloadCleanupDeletionResult,
  ClaimPayloadCleanupInput,
  ClaimPayloadCleanupResult,
  FinalizePayloadCleanupDeletionInput,
  PayloadCleanupClaim,
  PayloadCleanupTask,
  PayloadPage,
  ReleasePayloadCleanupClaimInput,
} from "../types.js";

export class PostgresPayloadCleanupRepository {
  readonly #ctx: PostgresRepositoryContext;

  constructor(ctx: PostgresRepositoryContext) {
    this.#ctx = ctx;
  }

  async claimPayloadCleanup(
    input: ClaimPayloadCleanupInput,
  ): Promise<ClaimPayloadCleanupResult> {
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.lockPayloadObject(input.objectKey);
      const current = await selectRecord<PayloadCleanupClaim>(
        this.#ctx.client(),
        `SELECT record
           FROM reference_payload_cleanup_claims
           WHERE object_key = $1
           FOR UPDATE`,
        [input.objectKey],
      );
      const reference =
        await this.#ctx.repository.getPayloadReferenceByObjectKey(
          input.objectKey,
        );
      if (reference !== undefined) {
        if (current !== undefined && current.state !== "deleted") {
          await this.#ctx
            .client()
            .query(
              "DELETE FROM reference_payload_cleanup_claims WHERE object_key = $1",
              [input.objectKey],
            );
        }
        return { status: "referenced" };
      }
      if (input.uploadIntentId !== undefined) {
        const intent = await this.#ctx.repository.getPayloadUploadIntent(
          input.uploadIntentId,
        );
        if (
          input.uploadGeneration === undefined ||
          ((intent === undefined ||
            intent.objectKey !== input.objectKey ||
            intent.uploadGeneration !== input.uploadGeneration) &&
            !(
              current?.uploadIntentId === input.uploadIntentId &&
              current.uploadGeneration === input.uploadGeneration &&
              current.objectKey === input.objectKey
            ))
        ) {
          return { status: "intent_missing" };
        }
      } else if (input.uploadGeneration !== undefined) {
        return { status: "intent_missing" };
      } else if (
        (await this.#ctx.repository.getPayloadUploadIntentByObjectKey(
          input.objectKey,
        )) !== undefined
      ) {
        return { status: "intent_present" };
      }
      if (current?.state === "deleted" && input.reason !== "legacy_orphan") {
        return { status: "deleted", claim: current };
      }
      if (current !== undefined && current.leaseExpiresAt > input.timestamp) {
        return current.state === "claimed" && current.claimId === input.claimId
          ? { status: "claimed", claim: current }
          : { status: "busy", claim: current };
      }
      const claim: PayloadCleanupClaim = {
        objectKey: input.objectKey,
        claimId: input.claimId,
        generation: (current?.generation ?? 0) + 1,
        state: current?.state === "deleting" ? "deleting" : "claimed",
        reason: input.reason,
        createdAt: current?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
        leaseExpiresAt: input.leaseExpiresAt,
        ...(input.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: input.uploadIntentId }),
        ...(input.uploadGeneration === undefined
          ? {}
          : { uploadGeneration: input.uploadGeneration }),
      };
      await this.#ctx.client().query(
        `INSERT INTO reference_payload_cleanup_claims(
             object_key, claim_id, generation, state, reason, upload_intent_id,
             upload_generation,
             created_at, updated_at, lease_expires_at, last_error_code, record
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11::jsonb
           )
           ON CONFLICT(object_key) DO UPDATE SET
             claim_id = EXCLUDED.claim_id,
             generation = EXCLUDED.generation,
             state = EXCLUDED.state,
             reason = EXCLUDED.reason,
             upload_intent_id = EXCLUDED.upload_intent_id,
             upload_generation = EXCLUDED.upload_generation,
             updated_at = EXCLUDED.updated_at,
             lease_expires_at = EXCLUDED.lease_expires_at,
             last_error_code = NULL,
             record = EXCLUDED.record`,
        [
          claim.objectKey,
          claim.claimId,
          claim.generation,
          claim.state,
          claim.reason,
          claim.uploadIntentId ?? null,
          claim.uploadGeneration ?? null,
          claim.createdAt,
          claim.updatedAt,
          claim.leaseExpiresAt,
          JSON.stringify(claim),
        ],
      );
      return { status: "claimed", claim };
    });
  }

  async beginPayloadCleanupDeletion(
    input: BeginPayloadCleanupDeletionInput,
  ): Promise<BeginPayloadCleanupDeletionResult> {
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.lockPayloadObject(input.objectKey);
      const reference =
        await this.#ctx.repository.getPayloadReferenceByObjectKey(
          input.objectKey,
        );
      if (reference !== undefined) {
        await this.#ctx.client().query(
          `DELETE FROM reference_payload_cleanup_claims
             WHERE object_key = $1 AND claim_id = $2 AND generation = $3`,
          [input.objectKey, input.claimId, input.generation],
        );
        return { status: "referenced" };
      }
      const current = await selectRecord<PayloadCleanupClaim>(
        this.#ctx.client(),
        `SELECT record
           FROM reference_payload_cleanup_claims
           WHERE object_key = $1
           FOR UPDATE`,
        [input.objectKey],
      );
      if (
        current === undefined ||
        current.claimId !== input.claimId ||
        current.generation !== input.generation ||
        current.uploadIntentId !== input.uploadIntentId ||
        current.uploadGeneration !== input.uploadGeneration
      ) {
        return { status: "lost" };
      }
      if (current.state === "deleted") {
        return { status: "deleted" };
      }
      if (current.state !== "claimed" && current.state !== "deleting") {
        return { status: "lost" };
      }
      const deleting: PayloadCleanupClaim = {
        ...current,
        state: "deleting",
        updatedAt: input.timestamp,
        leaseExpiresAt: input.leaseExpiresAt,
      };
      await this.#ctx.client().query(
        `UPDATE reference_payload_cleanup_claims
           SET state = 'deleting',
               updated_at = $4,
               lease_expires_at = $5,
               record = $6::jsonb
           WHERE object_key = $1 AND claim_id = $2 AND generation = $3`,
        [
          input.objectKey,
          input.claimId,
          input.generation,
          input.timestamp,
          input.leaseExpiresAt,
          JSON.stringify(deleting),
        ],
      );
      return { status: "deleting", claim: deleting };
    });
  }

  async finalizePayloadCleanupDeletion(
    input: FinalizePayloadCleanupDeletionInput,
  ): Promise<boolean> {
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.lockPayloadObject(input.objectKey);
      const current = await selectRecord<PayloadCleanupClaim>(
        this.#ctx.client(),
        `SELECT record
           FROM reference_payload_cleanup_claims
           WHERE object_key = $1
           FOR UPDATE`,
        [input.objectKey],
      );
      if (
        current === undefined ||
        current.state !== "deleting" ||
        current.claimId !== input.claimId ||
        current.generation !== input.generation ||
        current.uploadIntentId !== input.uploadIntentId ||
        current.uploadGeneration !== input.uploadGeneration
      ) {
        return false;
      }
      const deleted: PayloadCleanupClaim = {
        ...current,
        state: "deleted",
        updatedAt: input.timestamp,
      };
      await this.#ctx.client().query(
        `UPDATE reference_payload_cleanup_claims
           SET state = 'deleted', updated_at = $4, record = $5::jsonb
           WHERE object_key = $1 AND claim_id = $2 AND generation = $3`,
        [
          input.objectKey,
          input.claimId,
          input.generation,
          input.timestamp,
          JSON.stringify(deleted),
        ],
      );
      if (current.uploadIntentId !== undefined) {
        await this.#ctx.client().query(
          `DELETE FROM reference_payload_upload_intents
             WHERE id = $1
               AND object_key = $2
               AND upload_generation = $3`,
          [
            current.uploadIntentId,
            input.objectKey,
            current.uploadGeneration ?? null,
          ],
        );
      }
      return true;
    });
  }

  async releasePayloadCleanupClaim(
    input: ReleasePayloadCleanupClaimInput,
  ): Promise<boolean> {
    void input.timestamp;
    void input.errorCode;
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.lockPayloadObject(input.objectKey);
      const deleted = await this.#ctx.client().query(
        `DELETE FROM reference_payload_cleanup_claims
           WHERE object_key = $1
             AND claim_id = $2
             AND generation = $3
             AND upload_intent_id IS NOT DISTINCT FROM $4
             AND upload_generation IS NOT DISTINCT FROM $5
             AND state <> 'deleted'`,
        [
          input.objectKey,
          input.claimId,
          input.generation,
          input.uploadIntentId ?? null,
          input.uploadGeneration ?? null,
        ],
      );
      return deleted.rowCount !== 0;
    });
  }

  async getPayloadCleanupClaim(
    objectKey: string,
  ): Promise<PayloadCleanupClaim | undefined> {
    return selectRecord<PayloadCleanupClaim>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_payload_cleanup_claims
         WHERE object_key = $1`,
      [objectKey],
    );
  }

  async listExpiredPayloadCleanupClaims(
    now: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadCleanupClaim>> {
    const result = await this.#ctx
      .client()
      .query<JsonRecordRow & { readonly object_key: string }>(
        `SELECT object_key, record
         FROM reference_payload_cleanup_claims
         WHERE state <> 'deleted'
           AND lease_expires_at <= $1
           AND ($3::text IS NULL OR object_key > $3)
         ORDER BY object_key
         LIMIT $2`,
        [now, limit + 1, cursor ?? null],
      );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => asRecord<PayloadCleanupClaim>(row.record)),
      ...(result.rows.length > limit && rows.length > 0
        ? { nextCursor: rows[rows.length - 1]!.object_key }
        : {}),
    };
  }

  async listPayloadCleanupTasks(
    limit: number,
    endpointId?: string,
    cursor?: string,
  ): Promise<readonly PayloadCleanupTask[]> {
    const result = await this.#ctx.client().query<JsonRecordRow>(
      `SELECT record
         FROM reference_payload_cleanup_tasks
         WHERE ($2::text IS NULL OR endpoint_id = $2)
           AND ($3::text IS NULL OR id > $3)
         ORDER BY id
         LIMIT $1`,
      [limit, endpointId ?? null, cursor ?? null],
    );
    return result.rows.map((row) => asRecord<PayloadCleanupTask>(row.record));
  }

  async markPayloadCleanupFailed(
    id: string,
    timestamp: string,
    errorCode: string,
  ): Promise<void> {
    const current = await selectRecord<PayloadCleanupTask>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_payload_cleanup_tasks
         WHERE id = $1
         FOR UPDATE`,
      [id],
    );
    if (current === undefined) {
      return;
    }
    const next: PayloadCleanupTask = {
      ...current,
      state: "failed",
      attempts: current.attempts + 1,
      updatedAt: timestamp,
      lastErrorCode: referenceSha256(errorCode).slice(0, 16),
    };
    await this.#ctx.client().query(
      `UPDATE reference_payload_cleanup_tasks
         SET state = 'failed',
             attempts = $2,
             last_error_code = $3,
             updated_at = $4,
             record = $5::jsonb
         WHERE id = $1`,
      [id, next.attempts, next.lastErrorCode, timestamp, JSON.stringify(next)],
    );
  }

  async completePayloadCleanup(id: string): Promise<void> {
    await this.#ctx
      .client()
      .query("DELETE FROM reference_payload_cleanup_tasks WHERE id = $1", [id]);
  }
}
