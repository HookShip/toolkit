// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnits } from "../ordering.js";
import { InMemoryRepositoryState, copy } from "./memory-repository-state.js";
import type {
  SecretRepository,
  CreateSecretVersionInput,
  RotateSecretInput,
  SecretVersionRecord,
} from "../types.js";

export class InMemorySecretRepository implements SecretRepository {
  readonly #ctx: InMemoryRepositoryState;

  constructor(ctx: InMemoryRepositoryState) {
    this.#ctx = ctx;
  }

  async createSecretVersion(
    input: CreateSecretVersionInput,
  ): Promise<SecretVersionRecord> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("createSecretVersion");
      const endpoint = state.endpoints.get(input.endpointId);
      if (endpoint === undefined || endpoint.state === "deleted") {
        throw new Error("Cannot create a secret for a deleted endpoint.");
      }
      if (
        input.state === "active" &&
        [...state.secrets.values()].some(
          (secret) =>
            secret.endpointId === input.endpointId &&
            secret.state === "active" &&
            secret.id !== input.id,
        )
      ) {
        throw new Error("At most one active secret is allowed per endpoint.");
      }
      const value: SecretVersionRecord = {
        ...copy(input),
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      };
      state.secrets.set(value.id, value);
      return copy(value);
    });
  }

  async rotateSecret(input: RotateSecretInput): Promise<SecretVersionRecord> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("rotateSecret");
      const active = [...state.secrets.entries()].filter(
        ([, secret]) =>
          secret.endpointId === input.endpointId && secret.state === "active",
      );
      if (active.length !== 1) {
        throw new Error("Secret rotation requires exactly one active secret.");
      }
      for (const [id, secret] of active) {
        state.secrets.set(id, {
          ...secret,
          state: "overlapping",
          expiresAt: input.overlapUntil,
          updatedAt: input.timestamp,
        });
      }
      const replacement: SecretVersionRecord = {
        ...copy(input.replacement),
        createdAt: input.replacement.timestamp,
        updatedAt: input.replacement.timestamp,
      };
      state.secrets.set(replacement.id, replacement);
      return copy(replacement);
    });
  }

  async revokeSecret(
    endpointId: string,
    secretId: string,
    timestamp: string,
  ): Promise<SecretVersionRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("revokeSecret");
      const current = state.secrets.get(secretId);
      if (current === undefined || current.endpointId !== endpointId) {
        return undefined;
      }
      if (current.state === "revoked") {
        return copy(current);
      }
      const next: SecretVersionRecord = {
        ...current,
        state: "revoked",
        updatedAt: timestamp,
      };
      state.secrets.set(secretId, next);
      return copy(next);
    });
  }

  async getSecretVersion(
    endpointId: string,
    secretId: string,
  ): Promise<SecretVersionRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.secrets.get(secretId);
      return value === undefined || value.endpointId !== endpointId
        ? undefined
        : copy(value);
    });
  }

  async listSecretVersions(
    endpointId: string,
  ): Promise<readonly SecretVersionRecord[]> {
    return this.#ctx.withState(async (state) =>
      [...state.secrets.values()]
        .filter((secret) => secret.endpointId === endpointId)
        .sort((left, right) =>
          compareCodeUnits(right.createdAt, left.createdAt),
        )
        .map(copy),
    );
  }
}
