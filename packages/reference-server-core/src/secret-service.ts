// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { encodeWebhookSecret } from "@webhook-portal/signing";

import type { ReferenceServiceContext } from "./service-context.js";
import { ReferenceApiError, asSecretMetadata } from "./service-support.js";
import type { CreateSecretResult } from "./service.js";
import type { SecretVersionMetadata } from "./types.js";

export class SecretService {
  readonly #ctx: ReferenceServiceContext;

  constructor(ctx: ReferenceServiceContext) {
    this.#ctx = ctx;
  }

  async createSecret(
    endpointId: string,
    correlationId: string,
  ): Promise<CreateSecretResult> {
    const secret = encodeWebhookSecret(randomBytes(32));
    const encryptedValue = this.#ctx.cipher.encrypt(secret);
    const record = await this.#ctx.repository.transaction(
      async (repository) => {
        const endpoint = await repository.lockEndpoint(endpointId);
        if (endpoint === undefined || endpoint.state === "deleted") {
          throw new ReferenceApiError(
            404,
            "ENDPOINT_NOT_FOUND",
            "The endpoint was not found.",
          );
        }
        const existing = await repository.listSecretVersions(endpointId);
        if (existing.some((candidate) => candidate.state === "active")) {
          throw new ReferenceApiError(
            409,
            "ACTIVE_SECRET_EXISTS",
            "Rotate the active secret instead of creating another one.",
          );
        }
        const created = await repository.createSecretVersion({
          id: this.#ctx.idFactory(),
          endpointId,
          encryptedValue,
          state: "active",
          timestamp: this.#ctx.nowIso(),
        });
        await this.#ctx.audit(
          {
            action: "secret.create",
            resourceType: "secret_version",
            resourceId: created.id,
            result: "success",
            correlationId,
            details: { endpointId },
          },
          repository,
        );
        await this.#ctx.outbox(
          {
            topic: "secret.created",
            aggregateType: "secret_version",
            aggregateId: created.id,
            correlationId,
            payload: { endpointId },
          },
          repository,
        );
        return created;
      },
    );
    return { secret, metadata: asSecretMetadata(record) };
  }

  async rotateSecret(
    endpointId: string,
    overlapSeconds: number,
    correlationId: string,
  ): Promise<CreateSecretResult> {
    if (
      !Number.isSafeInteger(overlapSeconds) ||
      overlapSeconds < 3600 ||
      overlapSeconds > 7 * 24 * 60 * 60
    ) {
      throw new ReferenceApiError(
        400,
        "INVALID_OVERLAP",
        "Secret overlap must be between one hour and seven days.",
      );
    }
    const nowMilliseconds = this.#ctx.nowMilliseconds();
    const nowIso = new Date(nowMilliseconds).toISOString();
    const overlapUntil = Math.floor(nowMilliseconds / 1000) + overlapSeconds;
    const secret = encodeWebhookSecret(randomBytes(32));
    const encryptedValue = this.#ctx.cipher.encrypt(secret);
    const record = await this.#ctx.repository.transaction(
      async (repository) => {
        const endpoint = await repository.lockEndpoint(endpointId);
        if (endpoint === undefined || endpoint.state === "deleted") {
          throw new ReferenceApiError(
            404,
            "ENDPOINT_NOT_FOUND",
            "The endpoint was not found.",
          );
        }
        const current = await repository.listSecretVersions(endpointId);
        if (
          current.filter((candidate) => candidate.state === "active").length !==
          1
        ) {
          throw new ReferenceApiError(
            409,
            "NO_ACTIVE_SECRET",
            "Create an active secret before rotating it.",
          );
        }
        const created = await repository.rotateSecret({
          endpointId,
          overlapUntil,
          timestamp: nowIso,
          replacement: {
            id: this.#ctx.idFactory(),
            endpointId,
            encryptedValue,
            state: "active",
            timestamp: nowIso,
          },
        });
        await this.#ctx.audit(
          {
            action: "secret.rotate",
            resourceType: "secret_version",
            resourceId: created.id,
            result: "success",
            correlationId,
            details: { endpointId, overlapSeconds },
          },
          repository,
        );
        await this.#ctx.outbox(
          {
            topic: "secret.rotated",
            aggregateType: "secret_version",
            aggregateId: created.id,
            correlationId,
            payload: { endpointId, overlapSeconds },
          },
          repository,
        );
        return created;
      },
    );
    return { secret, metadata: asSecretMetadata(record) };
  }

  async revokeSecret(
    endpointId: string,
    secretId: string,
    correlationId: string,
  ): Promise<SecretVersionMetadata> {
    const record = await this.#ctx.repository.transaction(
      async (repository) => {
        await repository.lockEndpoint(endpointId);
        const current = await repository.getSecretVersion(endpointId, secretId);
        if (current === undefined) {
          throw new ReferenceApiError(
            404,
            "SECRET_NOT_FOUND",
            "The secret version was not found.",
          );
        }
        if (current.state === "revoked") {
          return current;
        }
        const revoked = await repository.revokeSecret(
          endpointId,
          secretId,
          this.#ctx.nowIso(),
        );
        if (revoked === undefined) {
          throw new ReferenceApiError(
            404,
            "SECRET_NOT_FOUND",
            "The secret version was not found.",
          );
        }
        await this.#ctx.audit(
          {
            action: "secret.revoke",
            resourceType: "secret_version",
            resourceId: secretId,
            result: "success",
            correlationId,
            details: { endpointId },
          },
          repository,
        );
        await this.#ctx.outbox(
          {
            topic: "secret.revoked",
            aggregateType: "secret_version",
            aggregateId: secretId,
            correlationId,
            payload: { endpointId },
          },
          repository,
        );
        return revoked;
      },
    );
    return asSecretMetadata(record);
  }

  async listSecretMetadata(
    endpointId: string,
  ): Promise<readonly SecretVersionMetadata[]> {
    const now = Math.floor(this.#ctx.nowMilliseconds() / 1000);
    return (await this.#ctx.repository.listSecretVersions(endpointId)).map(
      (record) =>
        asSecretMetadata(
          record.expiresAt !== undefined &&
            record.expiresAt < now &&
            record.state !== "revoked"
            ? { ...record, state: "expired" }
            : record,
        ),
    );
  }
}
