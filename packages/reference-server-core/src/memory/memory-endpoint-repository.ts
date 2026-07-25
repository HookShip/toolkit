// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnits } from "../ordering.js";
import {
  InMemoryRepositoryState,
  commandKey,
  copy,
} from "./memory-repository-state.js";
import type {
  EndpointRepository,
  CreateEndpointInput,
  EndpointDeletionResult,
  EndpointRecord,
  EndpointTombstone,
  PayloadCleanupTask,
  SetSubscriptionInput,
  SubscriptionRecord,
  UpdateEndpointInput,
} from "../types.js";

export class InMemoryEndpointRepository implements EndpointRepository {
  readonly #ctx: InMemoryRepositoryState;

  constructor(ctx: InMemoryRepositoryState) {
    this.#ctx = ctx;
  }

  async createEndpoint(input: CreateEndpointInput): Promise<EndpointRecord> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("createEndpoint");
      if (state.endpoints.has(input.id)) {
        throw new Error(`Endpoint "${input.id}" already exists.`);
      }
      const endpoint: EndpointRecord = {
        id: input.id,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        url: input.url,
        allowLocalNetwork: input.allowLocalNetwork,
        state: "active",
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
      };
      state.endpoints.set(endpoint.id, endpoint);
      return copy(endpoint);
    });
  }

  async getEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.endpoints.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async lockEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return this.getEndpoint(id);
  }

  async listEndpoints(): Promise<readonly EndpointRecord[]> {
    return this.#ctx.withState(async (state) =>
      [...state.endpoints.values()]
        .sort((left, right) =>
          compareCodeUnits(left.createdAt, right.createdAt),
        )
        .map(copy),
    );
  }

  async updateEndpoint(
    id: string,
    input: UpdateEndpointInput,
  ): Promise<EndpointRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("updateEndpoint");
      const current = state.endpoints.get(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.state === "deleted") {
        return copy(current);
      }
      if (input.state === "deleted") {
        throw new Error("Use deleteEndpointData to tombstone an endpoint.");
      }
      const next: EndpointRecord = {
        ...current,
        updatedAt: input.updatedAt,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.allowLocalNetwork === undefined
          ? {}
          : { allowLocalNetwork: input.allowLocalNetwork }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.description === undefined || input.description === null
          ? {}
          : { description: input.description }),
      };
      const normalized =
        input.description === null
          ? Object.fromEntries(
              Object.entries(next).filter(([key]) => key !== "description"),
            )
          : next;
      state.endpoints.set(id, normalized as unknown as EndpointRecord);
      return copy(normalized as unknown as EndpointRecord);
    });
  }

  async deleteEndpointData(
    id: string,
    timestamp: string,
  ): Promise<EndpointDeletionResult | undefined> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("deleteEndpointData");
      const current = state.endpoints.get(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.state === "deleted") {
        return {
          endpoint: copy(current),
          cleanupTasks: [...state.payloadCleanupTasks.values()]
            .filter((task) => task.endpointId === id)
            .map(copy),
          newlyDeleted: false,
        };
      }

      const deletedIdentities = new Set(
        [...state.timeline.entries()]
          .filter(([, entry]) => entry.current.endpointId === id)
          .map(([identity]) => identity),
      );
      const deletedDeliveryIds = new Set(
        [...state.timeline.values()]
          .filter((entry) => entry.current.endpointId === id)
          .map((entry) => entry.deliveryId),
      );

      for (const [referenceId, reference] of state.payloads) {
        const matchesEndpoint =
          reference.endpointId === id ||
          (reference.endpointId === undefined &&
            reference.deliveryId !== undefined &&
            deletedDeliveryIds.has(reference.deliveryId));
        if (!matchesEndpoint) {
          continue;
        }
        const task: PayloadCleanupTask = {
          id: `endpoint:${reference.id}`,
          objectKey: reference.objectKey,
          reason: "endpoint_deleted",
          state: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          endpointId: id,
        };
        state.payloadCleanupTasks.set(task.id, task);
        state.payloads.delete(referenceId);
      }
      for (const [intentId, intent] of state.payloadUploadIntents) {
        if (intent.endpointId !== id) {
          continue;
        }
        const task: PayloadCleanupTask = {
          id: `endpoint:${intent.id}`,
          objectKey: intent.objectKey,
          reason: "endpoint_deleted",
          state: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          endpointId: id,
        };
        state.payloadCleanupTasks.set(task.id, task);
        state.payloadUploadIntents.set(intentId, {
          ...intent,
          state: "orphaned",
          updatedAt: timestamp,
        });
      }

      for (const [dedupeKey, observation] of state.metadataObservations) {
        if (deletedIdentities.has(observation.identityKey)) {
          state.metadataObservations.delete(dedupeKey);
        }
      }
      for (const identity of deletedIdentities) {
        state.timeline.delete(identity);
      }
      state.subscriptions.delete(id);
      for (const [secretId, secret] of state.secrets) {
        if (secret.endpointId === id) {
          state.secrets.delete(secretId);
        }
      }
      for (const [commandId, command] of state.commands) {
        if (command.endpointId === id) {
          state.commands.delete(commandId);
          state.commandKeys.delete(
            commandKey(command.endpointId, command.idempotencyKey),
          );
        }
      }

      const tombstone: EndpointTombstone = {
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: timestamp,
        deletedAt: timestamp,
        state: "deleted",
        tombstoneVersion: 1,
      };
      state.endpoints.set(id, tombstone);
      return {
        endpoint: copy(tombstone),
        cleanupTasks: [...state.payloadCleanupTasks.values()]
          .filter((task) => task.endpointId === id)
          .map(copy),
        newlyDeleted: true,
      };
    });
  }

  async setSubscription(
    input: SetSubscriptionInput,
  ): Promise<SubscriptionRecord> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("setSubscription");
      const endpoint = state.endpoints.get(input.endpointId);
      if (endpoint === undefined || endpoint.state === "deleted") {
        throw new Error("Cannot subscribe a missing or deleted endpoint.");
      }
      const current = state.subscriptions.get(input.endpointId);
      const value: SubscriptionRecord = {
        id: current?.id ?? input.id,
        endpointId: input.endpointId,
        eventTypes: [...input.eventTypes],
        state: input.state,
        createdAt: current?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
      };
      state.subscriptions.set(input.endpointId, value);
      return copy(value);
    });
  }

  async getSubscription(
    endpointId: string,
  ): Promise<SubscriptionRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.subscriptions.get(endpointId);
      return value === undefined ? undefined : copy(value);
    });
  }
}
