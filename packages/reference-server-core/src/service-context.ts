// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  secretValue,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";
import {
  nodeHttpTransport,
  type HttpTransport,
  type ValidatedDestination,
} from "@webhook-portal/adapter-generic-http";
import { WebhookSecret } from "@webhook-portal/signing";

import type { SecretCipher } from "./crypto.js";
import type { PayloadStorage } from "./payload-storage.js";
import { ReferenceApiError, resolveDestination } from "./service-support.js";
import type { ReferenceServiceOptions } from "./service.js";
import type {
  AuditRecord,
  OutboxRecord,
  ReferenceRepository,
  ReferenceRepositoryTransaction,
  ReferenceServerConfig,
  SecretVersionRecord,
} from "./types.js";

export class ReferenceServiceContext {
  readonly #repository: ReferenceRepository;
  readonly #cipher: SecretCipher;
  readonly #config: ReferenceServerConfig;
  readonly #payloadStorage: PayloadStorage;
  readonly #transport: HttpTransport;
  readonly #clock: () => number | Date;
  readonly #idFactory: () => string;
  readonly #ingestCredential: ScopedCredential;

  constructor(options: ReferenceServiceOptions) {
    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#config = options.config;
    this.#payloadStorage = options.payloadStorage;
    if (
      options.config.payloadRetention.enabled &&
      (!options.payloadStorage.capabilities.capture ||
        !options.payloadStorage.capabilities.cleanup)
    ) {
      throw new RangeError(
        "Payload capture requires capture- and cleanup-capable object storage.",
      );
    }
    this.#transport = options.transport ?? nodeHttpTransport;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#ingestCredential = Object.freeze({
      id: options.config.ingestCredential.id,
      kind: "bearer",
      role: "metadata_ingest",
      scope: Object.freeze({
        adapterId: options.config.metadataIdentity.adapterId,
        connectionId: options.config.metadataIdentity.connectionId,
        environments: Object.freeze([
          options.config.metadataIdentity.environment,
        ]),
        operations: Object.freeze(["metadata.ingest"] as const),
        tenantId: options.config.metadataIdentity.tenantId,
      }),
      secret: secretValue(options.config.ingestCredential.secret, {
        id: options.config.ingestCredential.id,
        purpose: "metadata.ingest",
      }),
    });
  }

  nowMilliseconds(): number {
    const value = this.#clock();
    return value instanceof Date ? value.getTime() : value;
  }

  nowIso(): string {
    return new Date(this.nowMilliseconds()).toISOString();
  }

  auditRecord(
    input: Omit<AuditRecord, "id" | "createdAt" | "actorId">,
  ): AuditRecord {
    return {
      id: this.#idFactory(),
      createdAt: this.nowIso(),
      actorId: "local-user",
      ...input,
    };
  }

  async audit(
    input: Omit<AuditRecord, "id" | "createdAt" | "actorId">,
    repository: ReferenceRepositoryTransaction = this.#repository,
  ): Promise<void> {
    await repository.appendAudit(this.auditRecord(input));
  }

  async outbox(
    input: Omit<OutboxRecord, "id" | "createdAt">,
    repository: ReferenceRepositoryTransaction,
  ): Promise<void> {
    await repository.appendOutbox({
      id: this.#idFactory(),
      createdAt: this.nowIso(),
      ...input,
    });
  }

  async validateEndpointDestination(
    url: string,
    requestedLocalOptIn: boolean,
  ): Promise<ValidatedDestination> {
    if (requestedLocalOptIn && !this.#config.allowLocalNetwork) {
      throw new ReferenceApiError(
        403,
        "LOCAL_NETWORK_DISABLED",
        "The server was not started with local-network delivery enabled.",
      );
    }
    let destination: ValidatedDestination;
    try {
      destination = await resolveDestination(url, requestedLocalOptIn);
    } catch (error) {
      if (error instanceof ReferenceApiError) {
        throw error;
      }
      throw new ReferenceApiError(
        422,
        "UNSAFE_DESTINATION",
        "The endpoint destination is not allowed.",
      );
    }
    return destination;
  }

  async eligibleSecretRecords(
    endpointId: string,
    repository: ReferenceRepositoryTransaction = this.#repository,
  ): Promise<readonly SecretVersionRecord[]> {
    const now = Math.floor(this.nowMilliseconds() / 1000);
    return (await repository.listSecretVersions(endpointId)).filter(
      (record) => {
        return (
          (record.state === "active" || record.state === "overlapping") &&
          (record.notBefore === undefined || record.notBefore <= now) &&
          (record.expiresAt === undefined || record.expiresAt >= now)
        );
      },
    );
  }

  webhookSecret(record: SecretVersionRecord): WebhookSecret {
    const state =
      record.state === "active" || record.state === "overlapping"
        ? record.state
        : record.state === "expired"
          ? "expired"
          : "revoked";
    return WebhookSecret.fromEncoded(
      this.#cipher.decrypt(record.encryptedValue),
      {
        id: record.id,
        state,
        ...(record.notBefore === undefined
          ? {}
          : { notBefore: record.notBefore }),
        ...(record.expiresAt === undefined
          ? {}
          : { expiresAt: record.expiresAt }),
      },
    );
  }

  async eligibleSecrets(endpointId: string): Promise<readonly WebhookSecret[]> {
    return (await this.eligibleSecretRecords(endpointId)).map((record) =>
      this.webhookSecret(record),
    );
  }

  get repository(): ReferenceRepository {
    return this.#repository;
  }

  get cipher(): SecretCipher {
    return this.#cipher;
  }

  get config(): ReferenceServerConfig {
    return this.#config;
  }

  get payloadStorage(): PayloadStorage {
    return this.#payloadStorage;
  }

  get transport(): HttpTransport {
    return this.#transport;
  }

  get clock(): () => number | Date {
    return this.#clock;
  }

  idFactory(): string {
    return this.#idFactory();
  }

  get ingestCredential(): ScopedCredential {
    return this.#ingestCredential;
  }
}
