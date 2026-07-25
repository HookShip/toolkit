// SPDX-License-Identifier: Apache-2.0

import { referenceSha256 } from "../crypto.js";
import { compareCodeUnits } from "../ordering.js";
import { PayloadCleanupConflictError } from "../repository-errors.js";
import {
  InMemoryRepositoryState,
  copy,
  sameJson,
} from "./memory-repository-state.js";
import type {
  CreatePayloadReferenceInput,
  CreatePayloadUploadIntentInput,
  DeletePayloadReferenceInput,
  PayloadPage,
  PayloadReference,
  PayloadUploadIntent,
} from "../types.js";

export class InMemoryPayloadReferenceRepository {
  readonly #ctx: InMemoryRepositoryState;

  constructor(ctx: InMemoryRepositoryState) {
    this.#ctx = ctx;
  }

  async createPayloadReference(
    input: CreatePayloadReferenceInput,
  ): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("createPayloadReference");
      const cleanupClaim = state.payloadCleanupClaims.get(input.objectKey);
      if (
        cleanupClaim?.state === "deleting" ||
        cleanupClaim?.state === "deleted"
      ) {
        throw new PayloadCleanupConflictError(
          input.objectKey,
          cleanupClaim.state,
        );
      }
      const uploadIntent = [...state.payloadUploadIntents.values()].find(
        (intent) => intent.objectKey === input.objectKey,
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
      if (
        cleanupClaim?.state === "claimed" &&
        (cleanupClaim.uploadIntentId !== input.uploadAttemptId ||
          cleanupClaim.uploadGeneration !== input.uploadGeneration)
      ) {
        throw new Error("Payload cleanup ownership does not match the upload.");
      }
      const existing = state.payloads.get(input.id);
      if (existing !== undefined) {
        if (!sameJson(existing, input)) {
          throw new Error("A payload reference cannot be overwritten.");
        }
        if (cleanupClaim?.state === "claimed") {
          state.payloadCleanupClaims.delete(input.objectKey);
        }
        return;
      }
      if (
        [...state.payloads.values()].some(
          (reference) => reference.objectKey === input.objectKey,
        )
      ) {
        throw new Error("A payload object key can be referenced only once.");
      }
      if (cleanupClaim?.state === "claimed") {
        state.payloadCleanupClaims.delete(input.objectKey);
      }
      state.payloads.set(input.id, copy(input));
      if (uploadIntent !== undefined) {
        state.payloadUploadIntents.delete(uploadIntent.id);
      }
      if (input.deliveryId !== undefined) {
        for (const [identity, timeline] of state.timeline) {
          if (
            timeline.deliveryId === input.deliveryId &&
            (input.endpointId === undefined ||
              timeline.current.endpointId === input.endpointId)
          ) {
            state.timeline.set(identity, {
              ...timeline,
              payloadRetained: true,
            });
          }
        }
      }
    });
  }

  async getPayloadReference(id: string): Promise<PayloadReference | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.payloads.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async getPayloadReferenceByObjectKey(
    objectKey: string,
  ): Promise<PayloadReference | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = [...state.payloads.values()].find(
        (reference) => reference.objectKey === objectKey,
      );
      return value === undefined ? undefined : copy(value);
    });
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
    return this.#ctx.withState(async (state) => {
      const matches = [...state.payloads.values()]
        .filter(
          (value) =>
            cursor === undefined || compareCodeUnits(value.id, cursor) > 0,
        )
        .sort((left, right) => compareCodeUnits(left.id, right.id));
      const items = matches.slice(0, limit).map(copy);
      return {
        items,
        ...(matches.length > limit && items.length > 0
          ? { nextCursor: items[items.length - 1]!.id }
          : {}),
      };
    });
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
    return this.#ctx.withState(async (state) => {
      const matches = [...state.payloads.values()]
        .filter(
          (value) =>
            value.expiresAt <= now &&
            (cursor === undefined || compareCodeUnits(value.id, cursor) > 0),
        )
        .sort((left, right) => compareCodeUnits(left.id, right.id));
      const items = matches.slice(0, limit).map(copy);
      return {
        items,
        ...(matches.length > limit && items.length > 0
          ? { nextCursor: items[items.length - 1]!.id }
          : {}),
      };
    });
  }

  async deletePayloadReference(
    input: DeletePayloadReferenceInput,
  ): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("deletePayloadReference");
      const reference = state.payloads.get(input.id);
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
      state.payloads.delete(input.id);
      if (reference.deliveryId !== undefined) {
        for (const [identity, timeline] of state.timeline) {
          if (
            timeline.deliveryId === reference.deliveryId &&
            (reference.endpointId === undefined ||
              timeline.current.endpointId === reference.endpointId)
          ) {
            const retained = [...state.payloads.values()].some(
              (candidate) =>
                candidate.deliveryId === reference.deliveryId &&
                (candidate.endpointId === undefined ||
                  candidate.endpointId === timeline.current.endpointId),
            );
            state.timeline.set(identity, {
              ...timeline,
              payloadRetained: retained,
            });
          }
        }
      }
    });
  }

  async createPayloadUploadIntent(
    input: CreatePayloadUploadIntentInput,
  ): Promise<PayloadUploadIntent> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("createPayloadUploadIntent");
      if (
        input.id !== input.uploadAttemptId ||
        input.uploadGeneration.length === 0
      ) {
        throw new Error("Payload upload attempt ownership is invalid.");
      }
      const cleanupClaim = state.payloadCleanupClaims.get(input.objectKey);
      if (cleanupClaim?.state === "deleting") {
        throw new PayloadCleanupConflictError(input.objectKey, "deleting");
      }
      if (cleanupClaim?.state === "deleted") {
        throw new PayloadCleanupConflictError(input.objectKey, "deleted");
      }
      const existing = state.payloadUploadIntents.get(input.id);
      if (existing !== undefined) {
        const comparable = {
          ...existing,
          state: undefined,
          updatedAt: undefined,
          attempts: undefined,
          lastErrorCode: undefined,
        };
        if (
          !sameJson(
            Object.fromEntries(
              Object.entries(comparable).filter(
                ([, value]) => value !== undefined,
              ),
            ),
            input,
          )
        ) {
          throw new Error("A payload upload intent cannot be overwritten.");
        }
        if (cleanupClaim?.state === "claimed") {
          state.payloadCleanupClaims.delete(input.objectKey);
        }
        return copy(existing);
      }
      if (
        [...state.payloads.values()].some(
          (reference) => reference.objectKey === input.objectKey,
        )
      ) {
        throw new Error(
          "A referenced payload object key cannot start another upload.",
        );
      }
      if (
        [...state.payloadUploadIntents.values()].some(
          (intent) => intent.objectKey === input.objectKey,
        )
      ) {
        throw new Error("A payload object key can be reserved only once.");
      }
      if (cleanupClaim?.state === "claimed") {
        state.payloadCleanupClaims.delete(input.objectKey);
      }
      const intent: PayloadUploadIntent = {
        ...copy(input),
        state: "pending",
        updatedAt: input.createdAt,
        attempts: 0,
      };
      state.payloadUploadIntents.set(intent.id, intent);
      return copy(intent);
    });
  }

  async getPayloadUploadIntent(
    id: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.payloadUploadIntents.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async getPayloadUploadIntentByObjectKey(
    objectKey: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = [...state.payloadUploadIntents.values()].find(
        (intent) => intent.objectKey === objectKey,
      );
      return value === undefined ? undefined : copy(value);
    });
  }

  async listPayloadUploadIntents(
    olderThan: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadUploadIntent>> {
    return this.#ctx.withState(async (state) => {
      const matches = [...state.payloadUploadIntents.values()]
        .filter(
          (intent) =>
            intent.createdAt <= olderThan &&
            (cursor === undefined || compareCodeUnits(intent.id, cursor) > 0),
        )
        .sort((left, right) => compareCodeUnits(left.id, right.id));
      const items = matches.slice(0, limit).map(copy);
      return {
        items,
        ...(matches.length > limit && items.length > 0
          ? { nextCursor: items[items.length - 1]!.id }
          : {}),
      };
    });
  }

  async markPayloadUploadIntentOrphaned(
    id: string,
    uploadGeneration: string,
    timestamp: string,
    errorCode: string,
  ): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("markPayloadUploadIntentOrphaned");
      const current = state.payloadUploadIntents.get(id);
      if (current === undefined) {
        return;
      }
      if (current.uploadGeneration !== uploadGeneration) {
        throw new Error("Payload upload generation ownership was lost.");
      }
      state.payloadUploadIntents.set(id, {
        ...current,
        state: "orphaned",
        attempts: current.attempts + 1,
        updatedAt: timestamp,
        lastErrorCode: referenceSha256(errorCode).slice(0, 16),
      });
    });
  }

  async completePayloadUploadIntent(
    id: string,
    uploadGeneration: string,
  ): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("completePayloadUploadIntent");
      const intent = state.payloadUploadIntents.get(id);
      if (
        intent !== undefined &&
        intent.uploadGeneration !== uploadGeneration
      ) {
        throw new Error("Payload upload generation ownership was lost.");
      }
      state.payloadUploadIntents.delete(id);
    });
  }
}
