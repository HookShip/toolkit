// SPDX-License-Identifier: Apache-2.0

import { referenceSha256 } from "../crypto.js";
import { compareCodeUnits } from "../ordering.js";
import { InMemoryRepositoryState, copy } from "./memory-repository-state.js";
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

export class InMemoryPayloadCleanupRepository {
  readonly #ctx: InMemoryRepositoryState;

  constructor(ctx: InMemoryRepositoryState) {
    this.#ctx = ctx;
  }

  async claimPayloadCleanup(
    input: ClaimPayloadCleanupInput,
  ): Promise<ClaimPayloadCleanupResult> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("claimPayloadCleanup");
      const current = state.payloadCleanupClaims.get(input.objectKey);
      if (
        [...state.payloads.values()].some(
          (reference) => reference.objectKey === input.objectKey,
        )
      ) {
        if (current !== undefined && current.state !== "deleted") {
          state.payloadCleanupClaims.delete(input.objectKey);
        }
        return { status: "referenced" };
      }
      if (input.uploadIntentId !== undefined) {
        const intent = state.payloadUploadIntents.get(input.uploadIntentId);
        if (
          input.uploadGeneration === undefined ||
          ((intent === undefined || intent.objectKey !== input.objectKey) &&
            !(
              current?.uploadIntentId === input.uploadIntentId &&
              current.uploadGeneration === input.uploadGeneration &&
              current.objectKey === input.objectKey
            ))
        ) {
          return { status: "intent_missing" };
        }
        if (
          intent !== undefined &&
          intent.uploadGeneration !== input.uploadGeneration
        ) {
          return { status: "intent_missing" };
        }
      } else if (input.uploadGeneration !== undefined) {
        return { status: "intent_missing" };
      } else if (
        [...state.payloadUploadIntents.values()].some(
          (intent) => intent.objectKey === input.objectKey,
        )
      ) {
        return { status: "intent_present" };
      }
      if (current?.state === "deleted" && input.reason !== "legacy_orphan") {
        return { status: "deleted", claim: copy(current) };
      }
      if (current !== undefined && current.leaseExpiresAt > input.timestamp) {
        return current.state === "claimed" && current.claimId === input.claimId
          ? { status: "claimed", claim: copy(current) }
          : { status: "busy", claim: copy(current) };
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
      state.payloadCleanupClaims.set(input.objectKey, claim);
      return { status: "claimed", claim: copy(claim) };
    });
  }

  async beginPayloadCleanupDeletion(
    input: BeginPayloadCleanupDeletionInput,
  ): Promise<BeginPayloadCleanupDeletionResult> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("beginPayloadCleanupDeletion");
      if (
        [...state.payloads.values()].some(
          (reference) => reference.objectKey === input.objectKey,
        )
      ) {
        const current = state.payloadCleanupClaims.get(input.objectKey);
        if (
          current?.claimId === input.claimId &&
          current.generation === input.generation
        ) {
          state.payloadCleanupClaims.delete(input.objectKey);
        }
        return { status: "referenced" };
      }
      const current = state.payloadCleanupClaims.get(input.objectKey);
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
      state.payloadCleanupClaims.set(input.objectKey, deleting);
      return { status: "deleting", claim: copy(deleting) };
    });
  }

  async finalizePayloadCleanupDeletion(
    input: FinalizePayloadCleanupDeletionInput,
  ): Promise<boolean> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("finalizePayloadCleanupDeletion");
      const current = state.payloadCleanupClaims.get(input.objectKey);
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
      state.payloadCleanupClaims.set(input.objectKey, {
        ...current,
        state: "deleted",
        updatedAt: input.timestamp,
      });
      if (current.uploadIntentId !== undefined) {
        const intent = state.payloadUploadIntents.get(current.uploadIntentId);
        if (intent?.uploadGeneration === current.uploadGeneration) {
          state.payloadUploadIntents.delete(current.uploadIntentId);
        }
      }
      return true;
    });
  }

  async releasePayloadCleanupClaim(
    input: ReleasePayloadCleanupClaimInput,
  ): Promise<boolean> {
    void input.timestamp;
    void input.errorCode;
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("releasePayloadCleanupClaim");
      const current = state.payloadCleanupClaims.get(input.objectKey);
      if (
        current === undefined ||
        current.claimId !== input.claimId ||
        current.generation !== input.generation ||
        current.uploadIntentId !== input.uploadIntentId ||
        current.uploadGeneration !== input.uploadGeneration ||
        current.state === "deleted"
      ) {
        return false;
      }
      state.payloadCleanupClaims.delete(input.objectKey);
      return true;
    });
  }

  async getPayloadCleanupClaim(
    objectKey: string,
  ): Promise<PayloadCleanupClaim | undefined> {
    return this.#ctx.withState(async (state) => {
      const claim = state.payloadCleanupClaims.get(objectKey);
      return claim === undefined ? undefined : copy(claim);
    });
  }

  async listExpiredPayloadCleanupClaims(
    now: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadCleanupClaim>> {
    return this.#ctx.withState(async (state) => {
      const matches = [...state.payloadCleanupClaims.values()]
        .filter(
          (claim) =>
            claim.state !== "deleted" &&
            claim.leaseExpiresAt <= now &&
            (cursor === undefined ||
              compareCodeUnits(claim.objectKey, cursor) > 0),
        )
        .sort((left, right) =>
          compareCodeUnits(left.objectKey, right.objectKey),
        );
      const items = matches.slice(0, limit).map(copy);
      return {
        items,
        ...(matches.length > limit && items.length > 0
          ? { nextCursor: items[items.length - 1]!.objectKey }
          : {}),
      };
    });
  }

  async listPayloadCleanupTasks(
    limit: number,
    endpointId?: string,
    cursor?: string,
  ): Promise<readonly PayloadCleanupTask[]> {
    return this.#ctx.withState(async (state) =>
      [...state.payloadCleanupTasks.values()]
        .filter(
          (task) =>
            (endpointId === undefined || task.endpointId === endpointId) &&
            (cursor === undefined || compareCodeUnits(task.id, cursor) > 0),
        )
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .slice(0, limit)
        .map(copy),
    );
  }

  async markPayloadCleanupFailed(
    id: string,
    timestamp: string,
    errorCode: string,
  ): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("markPayloadCleanupFailed");
      const current = state.payloadCleanupTasks.get(id);
      if (current === undefined) {
        return;
      }
      state.payloadCleanupTasks.set(id, {
        ...current,
        state: "failed",
        attempts: current.attempts + 1,
        updatedAt: timestamp,
        lastErrorCode: referenceSha256(errorCode).slice(0, 16),
      });
    });
  }

  async completePayloadCleanup(id: string): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("completePayloadCleanup");
      state.payloadCleanupTasks.delete(id);
    });
  }
}
