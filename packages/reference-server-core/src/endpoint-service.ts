// SPDX-License-Identifier: Apache-2.0

import {
  tryVerifyWebhook,
  SignatureMismatchError,
  type VerificationResult,
  type WebhookHeadersInput,
} from "@webhook-portal/signing";

import { processPayloadCleanupTasks } from "./payload-storage.js";
import type { ReferenceServiceContext } from "./service-context.js";
import { ReferenceApiError } from "./service-support.js";
import type {
  CreateEndpointServiceInput,
  UpdateEndpointServiceInput,
} from "./service.js";
import type { EndpointRecord } from "./types.js";

export class EndpointService {
  readonly #ctx: ReferenceServiceContext;

  constructor(ctx: ReferenceServiceContext) {
    this.#ctx = ctx;
  }

  async createEndpoint(
    input: CreateEndpointServiceInput,
  ): Promise<EndpointRecord> {
    const destination = await this.#ctx.validateEndpointDestination(
      input.url,
      input.allowLocalNetwork,
    );
    return this.#ctx.repository.transaction(async (repository) => {
      const endpoint = await repository.createEndpoint({
        id: this.#ctx.idFactory(),
        createdAt: this.#ctx.nowIso(),
        url: destination.url.toString(),
        allowLocalNetwork: input.allowLocalNetwork,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
      });
      if (endpoint.state === "deleted") {
        throw new Error("A newly created endpoint cannot be a tombstone.");
      }
      await this.#ctx.audit(
        {
          action: "endpoint.create",
          resourceType: "endpoint",
          resourceId: endpoint.id,
          result: "success",
          correlationId: input.correlationId,
          details: {
            localNetwork: endpoint.allowLocalNetwork,
            scheme: new URL(endpoint.url).protocol,
          },
        },
        repository,
      );
      await this.#ctx.outbox(
        {
          topic: "endpoint.created",
          aggregateType: "endpoint",
          aggregateId: endpoint.id,
          correlationId: input.correlationId,
        },
        repository,
      );
      return endpoint;
    });
  }

  async updateEndpoint(
    id: string,
    input: UpdateEndpointServiceInput,
  ): Promise<EndpointRecord> {
    const current = await this.#ctx.repository.getEndpoint(id);
    if (current === undefined) {
      throw new ReferenceApiError(
        404,
        "ENDPOINT_NOT_FOUND",
        "The endpoint was not found.",
      );
    }
    if (current.state === "deleted") {
      if (input.state === "deleted") {
        return this.#deleteEndpoint(id, input.correlationId);
      }
      throw new ReferenceApiError(
        410,
        "ENDPOINT_DELETED",
        "A deleted endpoint cannot be changed or reactivated.",
      );
    }
    if (input.state === "deleted") {
      return this.#deleteEndpoint(id, input.correlationId);
    }
    let normalizedUrl: string | undefined;
    const localOptIn = input.allowLocalNetwork ?? current.allowLocalNetwork;
    if (input.url !== undefined) {
      const destination = await this.#ctx.validateEndpointDestination(
        input.url,
        localOptIn,
      );
      normalizedUrl = destination.url.toString();
    }
    return this.#ctx.repository.transaction(async (repository) => {
      const locked = await repository.lockEndpoint(id);
      if (locked === undefined) {
        throw new ReferenceApiError(
          404,
          "ENDPOINT_NOT_FOUND",
          "The endpoint was not found.",
        );
      }
      if (locked.state === "deleted") {
        throw new ReferenceApiError(
          410,
          "ENDPOINT_DELETED",
          "A deleted endpoint cannot be changed or reactivated.",
        );
      }
      if (
        normalizedUrl !== undefined &&
        input.allowLocalNetwork === undefined &&
        locked.allowLocalNetwork !== localOptIn
      ) {
        throw new ReferenceApiError(
          409,
          "ENDPOINT_CHANGED",
          "The endpoint changed while its destination was being validated; retry the update.",
        );
      }
      const updated = await repository.updateEndpoint(id, {
        updatedAt: this.#ctx.nowIso(),
        ...(normalizedUrl === undefined ? {} : { url: normalizedUrl }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.allowLocalNetwork === undefined
          ? {}
          : { allowLocalNetwork: input.allowLocalNetwork }),
        ...(input.state === undefined ? {} : { state: input.state }),
      });
      if (updated === undefined) {
        throw new ReferenceApiError(
          404,
          "ENDPOINT_NOT_FOUND",
          "The endpoint was not found.",
        );
      }
      if (updated.state === "deleted") {
        throw new ReferenceApiError(
          410,
          "ENDPOINT_DELETED",
          "A deleted endpoint cannot be changed or reactivated.",
        );
      }
      await this.#ctx.audit(
        {
          action: "endpoint.update",
          resourceType: "endpoint",
          resourceId: id,
          result: "success",
          correlationId: input.correlationId,
          details: {
            state: updated.state,
            localNetwork: updated.allowLocalNetwork,
          },
        },
        repository,
      );
      await this.#ctx.outbox(
        {
          topic: "endpoint.updated",
          aggregateType: "endpoint",
          aggregateId: id,
          correlationId: input.correlationId,
          payload: { state: updated.state },
        },
        repository,
      );
      return updated;
    });
  }

  async #deleteEndpoint(
    id: string,
    correlationId: string,
  ): Promise<EndpointRecord> {
    const deletion = await this.#ctx.repository.transaction(
      async (repository) => {
        const result = await repository.deleteEndpointData(
          id,
          this.#ctx.nowIso(),
        );
        if (result === undefined) {
          throw new ReferenceApiError(
            404,
            "ENDPOINT_NOT_FOUND",
            "The endpoint was not found.",
          );
        }
        if (result.newlyDeleted) {
          await this.#ctx.audit(
            {
              action: "endpoint.delete",
              resourceType: "endpoint",
              resourceId: id,
              result: "success",
              correlationId,
              details: {
                payloadCleanupCount: result.cleanupTasks.length,
                tombstoneVersion: result.endpoint.tombstoneVersion,
              },
            },
            repository,
          );
          await this.#ctx.outbox(
            {
              topic: "endpoint.deleted",
              aggregateType: "endpoint",
              aggregateId: id,
              correlationId,
              payload: {
                payloadCleanupCount: result.cleanupTasks.length,
                tombstoneVersion: result.endpoint.tombstoneVersion,
              },
            },
            repository,
          );
        }
        return result;
      },
    );
    const cleanup = await processPayloadCleanupTasks(
      this.#ctx.repository,
      this.#ctx.payloadStorage,
      this.#ctx.nowIso(),
      { endpointId: id, limit: 10_000 },
    );
    if (cleanup.failures.length > 0) {
      throw new ReferenceApiError(
        503,
        "ENDPOINT_PAYLOAD_CLEANUP_PENDING",
        "The endpoint is deleted, but one or more payload objects still require cleanup.",
        {
          endpointDeleted: true,
          pendingObjectCount: cleanup.failures.length,
        },
      );
    }
    return deletion.endpoint;
  }

  async setSubscriptions(
    endpointId: string,
    eventTypes: readonly string[],
    correlationId: string,
  ) {
    return this.#ctx.repository.transaction(async (repository) => {
      const endpoint = await repository.lockEndpoint(endpointId);
      if (endpoint === undefined || endpoint.state === "deleted") {
        throw new ReferenceApiError(
          404,
          "ENDPOINT_NOT_FOUND",
          "The endpoint was not found.",
        );
      }
      const release = await repository.getActiveRelease();
      if (release === undefined) {
        throw new ReferenceApiError(
          409,
          "NO_ACTIVE_RELEASE",
          "Publish a contract before configuring subscriptions.",
        );
      }
      const allowed = new Set(
        release.contract.eventTypes.flatMap((event) => [
          event.id,
          event.externalName,
        ]),
      );
      const normalized = [...new Set(eventTypes)].sort();
      const unsupported = normalized.filter((value) => !allowed.has(value));
      if (unsupported.length > 0) {
        throw new ReferenceApiError(
          422,
          "UNKNOWN_EVENT_TYPES",
          "One or more event types are not in the active release.",
          { count: unsupported.length },
        );
      }
      const subscription = await repository.setSubscription({
        id: this.#ctx.idFactory(),
        endpointId,
        eventTypes: normalized,
        state: "active",
        timestamp: this.#ctx.nowIso(),
      });
      await this.#ctx.audit(
        {
          action: "subscription.replace",
          resourceType: "subscription",
          resourceId: subscription.id,
          result: "success",
          correlationId,
          details: { eventTypeCount: normalized.length },
        },
        repository,
      );
      await this.#ctx.outbox(
        {
          topic: "subscription.replaced",
          aggregateType: "subscription",
          aggregateId: subscription.id,
          correlationId,
          payload: {
            endpointId,
            eventTypeCount: normalized.length,
          },
        },
        repository,
      );
      return subscription;
    });
  }

  async verifyEndpointWebhook(
    endpointId: string,
    body: Uint8Array,
    headers: WebhookHeadersInput,
  ): Promise<VerificationResult> {
    const secrets = await this.#ctx.eligibleSecrets(endpointId);
    if (secrets.length === 0) {
      return {
        ok: false,
        error: new SignatureMismatchError(),
      };
    }
    return tryVerifyWebhook({
      body,
      headers,
      secrets,
      clock: this.#ctx.clock,
      toleranceSeconds: 300,
    });
  }
}
