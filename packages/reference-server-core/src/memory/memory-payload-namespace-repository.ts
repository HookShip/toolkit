// SPDX-License-Identifier: Apache-2.0

import { InMemoryRepositoryState, copy } from "./memory-repository-state.js";
import type { PayloadStorageNamespaceState } from "../types.js";

export class InMemoryPayloadNamespaceRepository {
  readonly #ctx: InMemoryRepositoryState;

  constructor(ctx: InMemoryRepositoryState) {
    this.#ctx = ctx;
  }

  async getPayloadStorageNamespace(): Promise<
    PayloadStorageNamespaceState | undefined
  > {
    return this.#ctx.withState(async (state) =>
      state.payloadStorageNamespace === undefined
        ? undefined
        : copy(state.payloadStorageNamespace),
    );
  }

  async initializePayloadStorageNamespace(
    namespace: string,
    storeId: string,
    timestamp: string,
  ): Promise<PayloadStorageNamespaceState> {
    if (!/^[0-9a-f]{22}$/u.test(namespace)) {
      throw new RangeError("Payload storage namespace ID is invalid.");
    }
    if (!/^[0-9a-f]{22}$/u.test(storeId)) {
      throw new RangeError("Payload storage store ID is invalid.");
    }
    if (namespace === storeId) {
      throw new RangeError(
        "Payload storage namespace and store IDs must be distinct.",
      );
    }
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("initializePayloadStorageNamespace");
      const current = state.payloadStorageNamespace;
      if (current !== undefined) {
        if (current.namespace !== namespace) {
          throw new Error("Payload storage namespace does not match.");
        }
        if (current.storeId !== undefined && current.storeId !== storeId) {
          throw new Error("Payload storage store ID does not match.");
        }
        if (current.storeId === undefined) {
          const claimed: PayloadStorageNamespaceState = {
            ...current,
            storeId,
            status: current.status === "ready" ? "upgrading" : current.status,
            updatedAt: timestamp,
          };
          state.payloadStorageNamespace = claimed;
          return copy(claimed);
        }
        return copy(current);
      }
      const created: PayloadStorageNamespaceState = {
        namespace,
        storeId,
        status: "binding",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.payloadStorageNamespace = created;
      return copy(created);
    });
  }

  async markPayloadStorageNamespaceReady(
    namespace: string,
    storeId: string,
    timestamp: string,
  ): Promise<PayloadStorageNamespaceState> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("markPayloadStorageNamespaceReady");
      const current = state.payloadStorageNamespace;
      if (
        current === undefined ||
        current.namespace !== namespace ||
        current.storeId !== storeId
      ) {
        throw new Error("Payload storage binding does not match.");
      }
      const ready: PayloadStorageNamespaceState = {
        ...current,
        status: "ready",
        updatedAt: timestamp,
      };
      state.payloadStorageNamespace = ready;
      return copy(ready);
    });
  }

  async hasPayloadDataState(): Promise<boolean> {
    return this.#ctx.withState(async (state) =>
      Boolean(
        state.payloads.size > 0 ||
        state.payloadUploadIntents.size > 0 ||
        state.payloadCleanupClaims.size > 0 ||
        state.payloadCleanupTasks.size > 0,
      ),
    );
  }

  async hasPayloadPersistenceState(): Promise<boolean> {
    return (
      (await this.getPayloadStorageNamespace()) !== undefined ||
      (await this.hasPayloadDataState())
    );
  }
}
