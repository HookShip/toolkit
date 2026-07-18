// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID } from "node:crypto";

import {
  DEFAULT_ADAPTER_MAPPING_VERSION,
  canonicalizeMetadataRecord,
  createAuthenticatedMetadataIngestEnvelope,
  secretValue,
  type AuthenticatedMetadataIngestEnvelope,
  type MetadataDeliveryAttemptInput,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";
import {
  createMetadataIngestVerifier,
  nodeHttpTransport,
  type HttpTransport,
  type ValidatedDestination,
} from "@webhook-portal/adapter-generic-http";
import {
  canonicalize,
  diff,
  fixtures,
  type CanonicalContract,
  type CanonicalEventVersion,
  type JsonValue,
} from "@webhook-portal/contract-core";
import {
  SignatureMismatchError,
  WebhookSecret,
  encodeWebhookSecret,
  signWebhook,
  tryVerifyWebhook,
  type VerificationResult,
  type WebhookHeadersInput,
} from "@webhook-portal/signing";

import { referenceSha256, type SecretCipher } from "./crypto.js";
import { InvalidTimelineCursorError } from "./cursor.js";
import { resolveSafeDestination } from "../destination.js";
import { selectCanonicalEventVersion } from "../event-version.js";
import {
  processPayloadCleanupTasks,
  type PayloadStorage,
} from "./payload-storage.js";
import {
  PayloadCleanupConflictError,
  RepositoryCommitUncertainError,
} from "./repository-errors.js";
import { releaseMetadata } from "./release-metadata.js";
import {
  type AuditRecord,
  type ContractImportRecord,
  type CreatePayloadUploadIntentInput,
  type EndpointRecord,
  type MetadataIngestSummary,
  type OutboxRecord,
  type PublishCommandRecord,
  type PublishStatus,
  type ReferenceRepository,
  type ReferenceRepositoryTransaction,
  type ReferenceServerConfig,
  type ReleaseChangelog,
  type ReleaseMetadata,
  type ReleaseRecord,
  type SecretVersionMetadata,
  type SecretVersionRecord,
  type TestCommandRecord,
  type TestCommandResult,
  type TimelineFilters,
  type TimelinePage,
} from "./types.js";

export class ReferenceApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Readonly<Record<string, JsonValue>> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = "ReferenceApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface ReferenceServiceOptions {
  readonly repository: ReferenceRepository;
  readonly cipher: SecretCipher;
  readonly config: ReferenceServerConfig;
  readonly payloadStorage: PayloadStorage;
  readonly transport?: HttpTransport;
  readonly clock?: () => number | Date;
  readonly idFactory?: () => string;
}

export interface ImportContractInput {
  readonly source: string;
  readonly sourceMediaType: "application/json" | "application/yaml";
  readonly sourceUri?: string;
  readonly correlationId: string;
}

export interface CreateEndpointServiceInput {
  readonly url: string;
  readonly description?: string;
  readonly allowLocalNetwork: boolean;
  readonly correlationId: string;
}

export interface UpdateEndpointServiceInput {
  readonly url?: string;
  readonly description?: string | null;
  readonly allowLocalNetwork?: boolean;
  readonly state?: "active" | "deleted" | "paused";
  readonly correlationId: string;
}

export interface SendTestServiceInput {
  readonly endpointId: string;
  readonly eventType: string;
  readonly eventVersion?: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface CreateSecretResult {
  readonly secret: string;
  readonly metadata: SecretVersionMetadata;
}

export type PublishServiceStatus =
  | {
      readonly status: "not_found";
      readonly idempotencyKey: string;
    }
  | {
      readonly status: "pending";
      readonly idempotencyKey: string;
      readonly command: PublishCommandRecord;
    }
  | {
      readonly status: "completed";
      readonly idempotencyKey: string;
      readonly command: PublishCommandRecord;
      readonly release: ReleaseMetadata;
    }
  | {
      readonly status: "inconsistent";
      readonly idempotencyKey: string;
      readonly command: PublishCommandRecord;
      readonly reason: "release_not_found";
    };

export type PublishRecoveryResult =
  | PublishServiceStatus
  | {
      readonly status: "conflict";
      readonly idempotencyKey: string;
      readonly expectedFingerprint: string;
      readonly actualFingerprint: string;
    }
  | {
      readonly status: "unknown";
      readonly idempotencyKey: string;
      readonly requestFingerprint?: string;
    };

export { releaseMetadata } from "./release-metadata.js";

function publishServiceStatus(status: PublishStatus): PublishServiceStatus {
  if (status.status !== "completed") {
    return status;
  }
  return {
    ...status,
    release: releaseMetadata(status.release),
  };
}

function sha256(value: Uint8Array | string): string {
  return referenceSha256(value);
}

export function publishRequestFingerprint(
  canonicalChecksum: string,
  overrideReason?: string,
): string {
  return sha256(
    JSON.stringify({
      canonicalChecksum,
      overrideReason: overrideReason ?? null,
    }),
  );
}

function payloadCleanupApiError(
  error: PayloadCleanupConflictError,
): ReferenceApiError {
  return new ReferenceApiError(
    409,
    error.state === "deleted"
      ? "PAYLOAD_REUPLOAD_REQUIRED"
      : "PAYLOAD_CLEANUP_IN_PROGRESS",
    error.state === "deleted"
      ? "The retained payload was deleted during reconciliation; retry to upload it again."
      : "The retained payload is being reconciled; retry after cleanup completes.",
    {
      retryable: true,
      cleanupState: error.state,
    },
  );
}

function asSecretMetadata(record: SecretVersionRecord): SecretVersionMetadata {
  return {
    id: record.id,
    endpointId: record.endpointId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    state: record.state,
    ...(record.notBefore === undefined ? {} : { notBefore: record.notBefore }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

function pickEvent(
  contract: CanonicalContract,
  eventType: string,
  publicVersion?: string,
): { readonly version: CanonicalEventVersion } {
  const selected = selectCanonicalEventVersion(
    contract,
    eventType,
    publicVersion,
  );
  if (selected.status === "version_required") {
    throw new ReferenceApiError(
      400,
      "EVENT_VERSION_REQUIRED",
      "The event has multiple public versions; provide an explicit version.",
      { availableVersions: selected.availableVersions },
    );
  }
  if (selected.status === "invalid_current_version") {
    throw new ReferenceApiError(
      422,
      "INVALID_CURRENT_EVENT_VERSION",
      "The release marks an invalid or ambiguous current event version.",
      { availableVersions: selected.availableVersions },
    );
  }
  if (selected.status !== "found") {
    throw new ReferenceApiError(
      404,
      "EVENT_NOT_FOUND",
      "The published event type was not found.",
      { availableVersions: selected.availableVersions },
    );
  }
  return { version: selected.version };
}

function safeFixture(version: CanonicalEventVersion): JsonValue {
  const example = version.examples[0]?.value;
  if (example !== undefined) {
    return example;
  }
  const generated = fixtures(version.schema.value);
  if (generated.status !== "generated" || generated.value === undefined) {
    throw new ReferenceApiError(
      422,
      "FIXTURE_NOT_EXACT",
      "The event schema cannot produce an exact canonical fixture.",
      { generationStatus: generated.status },
    );
  }
  return generated.value;
}

async function resolveDestination(
  url: string,
  allowLocalNetwork: boolean,
): Promise<ValidatedDestination> {
  return resolveSafeDestination(url, { allowLocalNetwork });
}

export class ReferenceService {
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

  #nowMilliseconds(): number {
    const value = this.#clock();
    return value instanceof Date ? value.getTime() : value;
  }

  #nowIso(): string {
    return new Date(this.#nowMilliseconds()).toISOString();
  }

  #auditRecord(
    input: Omit<AuditRecord, "id" | "createdAt" | "actorId">,
  ): AuditRecord {
    return {
      id: this.#idFactory(),
      createdAt: this.#nowIso(),
      actorId: "local-user",
      ...input,
    };
  }

  async #audit(
    input: Omit<AuditRecord, "id" | "createdAt" | "actorId">,
    repository: ReferenceRepositoryTransaction = this.#repository,
  ): Promise<void> {
    await repository.appendAudit(this.#auditRecord(input));
  }

  async #outbox(
    input: Omit<OutboxRecord, "id" | "createdAt">,
    repository: ReferenceRepositoryTransaction,
  ): Promise<void> {
    await repository.appendOutbox({
      id: this.#idFactory(),
      createdAt: this.#nowIso(),
      ...input,
    });
  }

  async importContract(
    input: ImportContractInput,
  ): Promise<ContractImportRecord> {
    const result = canonicalize(input.source, {
      formatHint:
        input.sourceMediaType === "application/json" ? "json" : "yaml",
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
      limits: {
        maxInputBytes: this.#config.contractBodyLimitBytes,
      },
    });
    const record: ContractImportRecord = {
      id: this.#idFactory(),
      createdAt: this.#nowIso(),
      source: input.source,
      sourceMediaType: input.sourceMediaType,
      status: result.status,
      diagnostics: result.diagnostics,
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
      ...(result.parsed.sourceChecksum === undefined
        ? {}
        : { sourceChecksum: result.parsed.sourceChecksum.value }),
      ...(result.contract === undefined ? {} : { contract: result.contract }),
      ...(result.export === undefined
        ? {}
        : { canonicalExport: result.export }),
    };
    await this.#repository.createContractImport(record);
    await this.#audit({
      action: "contract.import",
      resourceType: "contract_import",
      resourceId: record.id,
      result: result.status === "valid" ? "success" : "failure",
      correlationId: input.correlationId,
      details: {
        status: result.status,
        diagnosticCount: result.diagnostics.length,
      },
    });
    return record;
  }

  async publishRelease(
    importId: string,
    correlationId: string,
    overrideReason?: string,
    idempotencyKey?: string,
  ): Promise<ReleaseMetadata> {
    const trimmedReason = overrideReason?.trim();
    const reason =
      trimmedReason === undefined || trimmedReason.length === 0
        ? undefined
        : trimmedReason;
    if (reason !== undefined && reason.length > 500) {
      throw new ReferenceApiError(
        400,
        "OVERRIDE_REASON_TOO_LONG",
        "The override reason exceeds 500 characters.",
      );
    }
    const importRecord = await this.#repository.getContractImport(importId);
    if (importRecord === undefined) {
      throw new ReferenceApiError(
        404,
        "IMPORT_NOT_FOUND",
        "The contract import was not found.",
      );
    }
    if (
      importRecord.status !== "valid" ||
      importRecord.contract === undefined ||
      importRecord.canonicalExport === undefined
    ) {
      throw new ReferenceApiError(
        422,
        "IMPORT_NOT_PUBLISHABLE",
        "Only a fully valid contract import can be published.",
        { importStatus: importRecord.status },
      );
    }
    const requestFingerprint = publishRequestFingerprint(
      importRecord.contract.checksum.value,
      reason,
    );
    const publishIdempotencyKey =
      idempotencyKey ?? `implicit:${requestFingerprint}`;
    let outcome:
      | {
          readonly kind: "incompatible";
          readonly compatibility: "breaking" | "unknown";
          readonly changeCount: number;
        }
      | { readonly kind: "conflict" }
      | { readonly kind: "pending" }
      | { readonly kind: "published"; readonly release: ReleaseRecord };
    try {
      outcome = await this.#repository.transaction(async (repository) => {
        const active = await repository.lockReleaseState();
        const existing = await repository.getPublishCommand(
          publishIdempotencyKey,
        );
        if (existing !== undefined) {
          if (existing.requestFingerprint !== requestFingerprint) {
            return { kind: "conflict" as const };
          }
          if (
            existing.state !== "completed" ||
            existing.releaseId === undefined
          ) {
            return { kind: "pending" as const };
          }
          const release = await repository.getRelease(existing.releaseId);
          if (release === undefined) {
            throw new Error("A completed publish command has no release.");
          }
          return { kind: "published" as const, release };
        }

        const compatibility =
          active === undefined
            ? undefined
            : diff(active.contract, importRecord.contract!);
        const blocked =
          compatibility?.status === "breaking" ||
          compatibility?.status === "unknown";
        if (blocked && !reason) {
          await this.#audit(
            {
              action: "release.publish",
              resourceType: "contract_import",
              resourceId: importId,
              result: "denied",
              correlationId,
              details: { compatibility: compatibility.status },
            },
            repository,
          );
          return {
            kind: "incompatible" as const,
            compatibility: compatibility.status,
            changeCount: compatibility.changes.length,
          };
        }

        const changelog: ReleaseChangelog =
          compatibility === undefined
            ? { summary: "Initial publication", status: "initial", changes: [] }
            : {
                summary: compatibility.summary,
                status: compatibility.status,
                changes: compatibility.changes,
              };
        const timestamp = this.#nowIso();
        const command: PublishCommandRecord = {
          id: this.#idFactory(),
          idempotencyKey: publishIdempotencyKey,
          requestFingerprint,
          importId,
          state: "requested",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await repository.createPublishCommand(command);
        const release = await repository.publishRelease({
          id: this.#idFactory(),
          importRecord,
          changelog,
          createdAt: timestamp,
          ...(compatibility === undefined ? {} : { compatibility }),
          ...(reason === undefined ? {} : { overrideReason: reason }),
        });
        await repository.completePublishCommand(
          command.id,
          release.id,
          active?.id,
          timestamp,
        );
        await this.#audit(
          {
            action: "release.publish",
            resourceType: "release",
            resourceId: release.id,
            result: "success",
            correlationId,
            details: {
              checksum: release.checksum,
              compatibility: changelog.status,
              overrideUsed: reason !== undefined,
              predecessorReleaseId: active?.id ?? null,
            },
          },
          repository,
        );
        await this.#outbox(
          {
            topic: "release.published",
            aggregateType: "release",
            aggregateId: release.id,
            correlationId,
            payload: {
              importId,
              predecessorReleaseId: active?.id ?? null,
              checksum: release.checksum,
            },
          },
          repository,
        );
        return { kind: "published" as const, release };
      });
    } catch (error) {
      if (!(error instanceof RepositoryCommitUncertainError)) {
        throw error;
      }
      const recovery = await this.recoverPublishStatus(
        publishIdempotencyKey,
        requestFingerprint,
      );
      if (recovery.status === "completed") {
        return recovery.release;
      }
      if (recovery.status === "conflict") {
        throw new ReferenceApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "The publish idempotency key was already used for another request.",
        );
      }
      if (recovery.status === "pending") {
        throw new ReferenceApiError(
          409,
          "PUBLISH_PENDING",
          "The original publish request is still pending.",
          {
            idempotencyKey: publishIdempotencyKey,
            publishStatus: "pending",
          },
        );
      }
      if (recovery.status === "not_found") {
        throw new ReferenceApiError(
          503,
          "PUBLISH_NOT_COMMITTED",
          "The publish was not observed after commit acknowledgement was lost.",
          {
            idempotencyKey: publishIdempotencyKey,
            publishStatus: "not_found",
            safeToRetry: true,
          },
        );
      }
      throw new ReferenceApiError(
        503,
        "PUBLISH_OUTCOME_UNKNOWN",
        "The publish outcome could not be reconciled.",
        {
          idempotencyKey: publishIdempotencyKey,
          publishStatus: recovery.status,
          safeToRetry: false,
        },
      );
    }

    if (outcome.kind === "conflict") {
      throw new ReferenceApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The publish idempotency key was already used for another request.",
      );
    }
    if (outcome.kind === "pending") {
      throw new ReferenceApiError(
        409,
        "PUBLISH_PENDING",
        "The original publish request is still pending.",
      );
    }
    if (outcome.kind === "incompatible") {
      throw new ReferenceApiError(
        409,
        "PUBLISH_INCOMPATIBLE",
        "Breaking or unknown compatibility changes require an explicit override reason.",
        {
          compatibility: outcome.compatibility,
          changeCount: outcome.changeCount,
        },
      );
    }
    return releaseMetadata(outcome.release);
  }

  async getPublishStatus(
    idempotencyKey: string,
  ): Promise<PublishServiceStatus> {
    return publishServiceStatus(
      await this.#repository.getPublishStatus(idempotencyKey),
    );
  }

  async recoverPublishStatus(
    idempotencyKey: string,
    expectedFingerprint?: string,
  ): Promise<PublishRecoveryResult> {
    let status: PublishStatus;
    try {
      status = await this.#repository.recoverPublishStatus(idempotencyKey);
    } catch {
      return {
        status: "unknown",
        idempotencyKey,
        ...(expectedFingerprint === undefined
          ? {}
          : { requestFingerprint: expectedFingerprint }),
      };
    }
    if (
      expectedFingerprint !== undefined &&
      status.status !== "not_found" &&
      status.command.requestFingerprint !== expectedFingerprint
    ) {
      return {
        status: "conflict",
        idempotencyKey,
        expectedFingerprint,
        actualFingerprint: status.command.requestFingerprint,
      };
    }
    return publishServiceStatus(status);
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

  async createEndpoint(
    input: CreateEndpointServiceInput,
  ): Promise<EndpointRecord> {
    const destination = await this.validateEndpointDestination(
      input.url,
      input.allowLocalNetwork,
    );
    return this.#repository.transaction(async (repository) => {
      const endpoint = await repository.createEndpoint({
        id: this.#idFactory(),
        createdAt: this.#nowIso(),
        url: destination.url.toString(),
        allowLocalNetwork: input.allowLocalNetwork,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
      });
      if (endpoint.state === "deleted") {
        throw new Error("A newly created endpoint cannot be a tombstone.");
      }
      await this.#audit(
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
      await this.#outbox(
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
    const current = await this.#repository.getEndpoint(id);
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
      const destination = await this.validateEndpointDestination(
        input.url,
        localOptIn,
      );
      normalizedUrl = destination.url.toString();
    }
    return this.#repository.transaction(async (repository) => {
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
        updatedAt: this.#nowIso(),
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
      await this.#audit(
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
      await this.#outbox(
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
    const deletion = await this.#repository.transaction(async (repository) => {
      const result = await repository.deleteEndpointData(id, this.#nowIso());
      if (result === undefined) {
        throw new ReferenceApiError(
          404,
          "ENDPOINT_NOT_FOUND",
          "The endpoint was not found.",
        );
      }
      if (result.newlyDeleted) {
        await this.#audit(
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
        await this.#outbox(
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
    });
    const cleanup = await processPayloadCleanupTasks(
      this.#repository,
      this.#payloadStorage,
      this.#nowIso(),
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
    return this.#repository.transaction(async (repository) => {
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
        id: this.#idFactory(),
        endpointId,
        eventTypes: normalized,
        state: "active",
        timestamp: this.#nowIso(),
      });
      await this.#audit(
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
      await this.#outbox(
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

  async createSecret(
    endpointId: string,
    correlationId: string,
  ): Promise<CreateSecretResult> {
    const secret = encodeWebhookSecret(randomBytes(32));
    const encryptedValue = this.#cipher.encrypt(secret);
    const record = await this.#repository.transaction(async (repository) => {
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
        id: this.#idFactory(),
        endpointId,
        encryptedValue,
        state: "active",
        timestamp: this.#nowIso(),
      });
      await this.#audit(
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
      await this.#outbox(
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
    });
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
    const nowMilliseconds = this.#nowMilliseconds();
    const nowIso = new Date(nowMilliseconds).toISOString();
    const overlapUntil = Math.floor(nowMilliseconds / 1000) + overlapSeconds;
    const secret = encodeWebhookSecret(randomBytes(32));
    const encryptedValue = this.#cipher.encrypt(secret);
    const record = await this.#repository.transaction(async (repository) => {
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
        current.filter((candidate) => candidate.state === "active").length !== 1
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
          id: this.#idFactory(),
          endpointId,
          encryptedValue,
          state: "active",
          timestamp: nowIso,
        },
      });
      await this.#audit(
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
      await this.#outbox(
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
    });
    return { secret, metadata: asSecretMetadata(record) };
  }

  async revokeSecret(
    endpointId: string,
    secretId: string,
    correlationId: string,
  ): Promise<SecretVersionMetadata> {
    const record = await this.#repository.transaction(async (repository) => {
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
        this.#nowIso(),
      );
      if (revoked === undefined) {
        throw new ReferenceApiError(
          404,
          "SECRET_NOT_FOUND",
          "The secret version was not found.",
        );
      }
      await this.#audit(
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
      await this.#outbox(
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
    });
    return asSecretMetadata(record);
  }

  async listSecretMetadata(
    endpointId: string,
  ): Promise<readonly SecretVersionMetadata[]> {
    const now = Math.floor(this.#nowMilliseconds() / 1000);
    return (await this.#repository.listSecretVersions(endpointId)).map(
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

  async #eligibleSecretRecords(
    endpointId: string,
    repository: ReferenceRepositoryTransaction = this.#repository,
  ): Promise<readonly SecretVersionRecord[]> {
    const now = Math.floor(this.#nowMilliseconds() / 1000);
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

  #webhookSecret(record: SecretVersionRecord): WebhookSecret {
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

  async #eligibleSecrets(
    endpointId: string,
  ): Promise<readonly WebhookSecret[]> {
    return (await this.#eligibleSecretRecords(endpointId)).map((record) =>
      this.#webhookSecret(record),
    );
  }

  async sendTest(input: SendTestServiceInput): Promise<TestCommandRecord> {
    const fingerprint = sha256(
      JSON.stringify({
        endpointId: input.endpointId,
        eventType: input.eventType,
        eventVersion: input.eventVersion ?? null,
      }),
    );
    const existing = await this.#repository.getTestCommandByIdempotency(
      input.endpointId,
      input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new ReferenceApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for a different test request.",
        );
      }
      return this.#resumeTestCommand(existing, input.correlationId);
    }

    const prepared = await this.#repository.transaction(async (repository) => {
      const raced = await repository.getTestCommandByIdempotency(
        input.endpointId,
        input.idempotencyKey,
      );
      if (raced !== undefined) {
        return raced.requestFingerprint === fingerprint
          ? { status: "existing" as const, command: raced }
          : { status: "conflict" as const, command: raced };
      }
      const endpoint = await repository.lockEndpoint(input.endpointId);
      if (endpoint === undefined || endpoint.state === "deleted") {
        throw new ReferenceApiError(
          404,
          "ENDPOINT_NOT_FOUND",
          "The endpoint was not found.",
        );
      }
      if (endpoint.state !== "active") {
        throw new ReferenceApiError(
          409,
          "ENDPOINT_NOT_ACTIVE",
          "The endpoint must be active before sending a test.",
        );
      }
      const subscription = await repository.getSubscription(endpoint.id);
      if (
        subscription === undefined ||
        !subscription.eventTypes.includes(input.eventType)
      ) {
        throw new ReferenceApiError(
          409,
          "EVENT_NOT_SUBSCRIBED",
          "The endpoint is not subscribed to the requested event type.",
        );
      }
      const release = await repository.getActiveRelease();
      if (release === undefined) {
        throw new ReferenceApiError(
          409,
          "NO_ACTIVE_RELEASE",
          "Publish a contract before sending a test.",
        );
      }
      const { version } = pickEvent(
        release.contract,
        input.eventType,
        input.eventVersion,
      );
      const payload = safeFixture(version);
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      if (body.byteLength > this.#config.sendTestBodyLimitBytes) {
        throw new ReferenceApiError(
          413,
          "TEST_BODY_TOO_LARGE",
          "The generated test body exceeds the configured limit.",
        );
      }
      const secret = (
        await this.#eligibleSecretRecords(endpoint.id, repository)
      )[0];
      const timestamp = this.#nowIso();
      const commandId = this.#idFactory();
      const messageId = `test_${this.#idFactory().replaceAll("-", "")}`;
      const context = {
        endpointUrl: endpoint.url,
        allowLocalNetwork: endpoint.allowLocalNetwork,
        releaseId: release.id,
        schemaChecksum: version.schema.checksum.value,
        eventVersion: version.publicVersion,
        bodySha256: sha256(body),
        messageId,
        ...(secret === undefined ? {} : { signingSecretId: secret.id }),
        ...(this.#config.payloadRetention.enabled
          ? {
              payload: {
                contentType: "application/json" as const,
                size: body.byteLength,
                ttlSeconds: this.#config.payloadRetention.ttlSeconds,
              },
            }
          : {}),
      };
      const started = await repository.beginTestCommand({
        id: commandId,
        endpointId: endpoint.id,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        context,
        timestamp,
      });
      if (started.status === "created") {
        await this.#audit(
          {
            action: "test.request",
            resourceType: "test_command",
            resourceId: started.command.id,
            result: "success",
            correlationId: input.correlationId,
            details: {
              endpointId: endpoint.id,
              eventType: input.eventType,
              releaseId: release.id,
            },
          },
          repository,
        );
        await this.#outbox(
          {
            topic: "test.requested",
            aggregateType: "test_command",
            aggregateId: started.command.id,
            correlationId: input.correlationId,
            payload: {
              endpointId: endpoint.id,
              eventType: input.eventType,
              releaseId: release.id,
            },
          },
          repository,
        );
      }
      return { ...started, body, secret };
    });
    if (prepared.status === "conflict") {
      throw new ReferenceApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different test request.",
      );
    }
    if (prepared.status === "existing") {
      return this.#resumeTestCommand(prepared.command, input.correlationId);
    }

    if (prepared.secret === undefined) {
      const result: TestCommandResult = {
        state: "rejected_before_dispatch",
        delivered: false,
        errorCategory: "secret_unavailable",
        detail: "No active, unexpired signing secret is available.",
      };
      return this.#stageAndCompleteTest(
        prepared.command.id,
        result,
        input.correlationId,
        prepared.body,
      );
    }

    let destination: ValidatedDestination;
    try {
      destination = await this.validateEndpointDestination(
        prepared.command.context.endpointUrl,
        prepared.command.context.allowLocalNetwork,
      );
    } catch {
      const result: TestCommandResult = {
        state: "rejected_before_dispatch",
        delivered: false,
        errorCategory: "destination_policy",
        detail: "The destination failed validation before dispatch.",
      };
      return this.#stageAndCompleteTest(
        prepared.command.id,
        result,
        input.correlationId,
        prepared.body,
      );
    }

    const dispatch = await this.#repository.transaction(async (repository) => {
      const endpoint = await repository.lockEndpoint(
        prepared.command.endpointId,
      );
      const command = await repository.lockTestCommand(prepared.command.id);
      if (command === undefined) {
        throw new ReferenceApiError(
          410,
          "TEST_COMMAND_REMOVED",
          "The test command was removed during endpoint deletion.",
        );
      }
      if (
        command.evidenceState === "complete" ||
        command.pendingResult !== undefined ||
        command.state !== "requested"
      ) {
        return { status: "existing" as const, command };
      }
      if (endpoint === undefined || endpoint.state !== "active") {
        return {
          status: "rejected" as const,
          command,
          result: {
            state: "rejected_before_dispatch",
            delivered: false,
            errorCategory: "endpoint_unavailable",
            detail: "The endpoint was paused or deleted before dispatch began.",
          } satisfies TestCommandResult,
        };
      }
      const secretId = command.context.signingSecretId;
      const secret =
        secretId === undefined
          ? undefined
          : await repository.getSecretVersion(command.endpointId, secretId);
      const eligible = await this.#eligibleSecretRecords(
        command.endpointId,
        repository,
      );
      if (
        secret === undefined ||
        !eligible.some((candidate) => candidate.id === secret.id)
      ) {
        return {
          status: "rejected" as const,
          command,
          result: {
            state: "rejected_before_dispatch",
            delivered: false,
            errorCategory: "secret_unavailable",
            detail:
              "The selected signing secret became unavailable before dispatch.",
          } satisfies TestCommandResult,
        };
      }
      const dispatched = await repository.markTestCommandDispatched(
        command.id,
        this.#nowIso(),
      );
      if (dispatched === undefined) {
        throw new Error("The test command disappeared before dispatch.");
      }
      await this.#audit(
        {
          action: "test.dispatch",
          resourceType: "test_command",
          resourceId: command.id,
          result: "success",
          correlationId: input.correlationId,
          details: { endpointId: command.endpointId },
        },
        repository,
      );
      await this.#outbox(
        {
          topic: "test.dispatched",
          aggregateType: "test_command",
          aggregateId: command.id,
          correlationId: input.correlationId,
          payload: { endpointId: command.endpointId },
        },
        repository,
      );
      return { status: "dispatched" as const, command: dispatched, secret };
    });
    if (dispatch.status === "existing") {
      return this.#resumeTestCommand(dispatch.command, input.correlationId);
    }
    if (dispatch.status === "rejected") {
      return this.#stageAndCompleteTest(
        dispatch.command.id,
        dispatch.result,
        input.correlationId,
        prepared.body,
      );
    }

    const signed = signWebhook({
      messageId: dispatch.command.context.messageId,
      body: prepared.body,
      secret: this.#webhookSecret(dispatch.secret),
      clock: this.#clock,
    });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Test delivery deadline exceeded.")),
      this.#config.sendTestTimeoutMilliseconds,
    );
    timer.unref();

    let result: TestCommandResult;
    try {
      const response = await this.#transport({
        method: "POST",
        url: destination.url,
        resolvedAddresses: destination.addresses,
        signal: controller.signal,
        maxResponseBodyBytes: 64 * 1024,
        maxResponseHeaderBytes: 32 * 1024,
        headers: Object.freeze({
          ...signed.headers,
          "content-type": "application/webhook+json",
          "content-length": String(prepared.body.byteLength),
          "user-agent": "webhook-portal-reference/1",
          "webhook-test": "true",
        }),
        body: prepared.body,
      });
      const delivered = response.status >= 200 && response.status < 300;
      result = {
        state: delivered ? "acknowledged" : "failed",
        delivered,
        statusCode: response.status,
        messageId: dispatch.command.context.messageId,
        ...(delivered
          ? {}
          : {
              errorCategory: "http",
              detail: "The endpoint returned a non-success status.",
            }),
      };
    } catch {
      result = {
        state: "unknown",
        delivered: false,
        messageId: dispatch.command.context.messageId,
        errorCategory: controller.signal.aborted ? "timeout" : "network",
        detail:
          "The request was dispatched, but the final delivery outcome is unknown.",
      };
    } finally {
      clearTimeout(timer);
    }
    return this.#stageAndCompleteTest(
      dispatch.command.id,
      result,
      input.correlationId,
      prepared.body,
    );
  }

  async #resumeTestCommand(
    command: TestCommandRecord,
    correlationId: string,
  ): Promise<TestCommandRecord> {
    if (command.evidenceState === "complete") {
      return command;
    }
    if (command.pendingResult !== undefined) {
      return this.#completeTestEvidence(command.id, correlationId);
    }
    const age = this.#nowMilliseconds() - Date.parse(command.updatedAt);
    if (age < this.#config.sendTestTimeoutMilliseconds) {
      return command;
    }
    const result: TestCommandResult =
      command.state === "requested"
        ? {
            state: "rejected_before_dispatch",
            delivered: false,
            errorCategory: "dispatch_not_started",
            detail:
              "The original request did not reach dispatch and was not resent.",
          }
        : {
            state: "unknown",
            delivered: false,
            messageId: command.context.messageId,
            errorCategory: "previous_outcome_unknown",
            detail:
              "The original at-most-once dispatch has no recoverable outcome and was not resent.",
          };
    return this.#stageAndCompleteTest(command.id, result, correlationId);
  }

  async #stageAndCompleteTest(
    commandId: string,
    result: TestCommandResult,
    correlationId: string,
    body?: Uint8Array,
  ): Promise<TestCommandRecord> {
    const staged = await this.#repository.transaction(async (repository) => {
      await repository.acquireTimelineEvidenceLocks({
        commandIds: [commandId],
      });
      const current = await repository.lockTestCommand(commandId);
      if (current === undefined) {
        throw new ReferenceApiError(
          404,
          "TEST_COMMAND_NOT_FOUND",
          "The test command was not found.",
        );
      }
      if (current.evidenceState === "complete") {
        return current;
      }
      const next = await repository.stageTestCommandResult(
        commandId,
        this.#nowIso(),
        result,
      );
      if (next === undefined) {
        throw new Error("The test command disappeared while staging a result.");
      }
      await this.#outbox(
        {
          topic: "test.result_staged",
          aggregateType: "test_command",
          aggregateId: commandId,
          correlationId,
          payload: { state: result.state },
        },
        repository,
      );
      return next;
    });
    if (staged.evidenceState === "complete") {
      return staged;
    }
    return this.#completeTestEvidence(commandId, correlationId, body);
  }

  async #testBody(command: TestCommandRecord): Promise<Buffer> {
    const release = await this.#repository.getRelease(
      command.context.releaseId,
    );
    if (release === undefined) {
      throw new Error("The immutable release for a test command is missing.");
    }
    const { version } = pickEvent(
      release.contract,
      command.eventType,
      command.context.eventVersion,
    );
    const body = Buffer.from(JSON.stringify(safeFixture(version)), "utf8");
    if (
      sha256(body) !== command.context.bodySha256 ||
      version.schema.checksum.value !== command.context.schemaChecksum ||
      version.publicVersion !== command.context.eventVersion
    ) {
      throw new Error("The immutable test request context is inconsistent.");
    }
    return body;
  }

  async #completeTestEvidence(
    commandId: string,
    correlationId: string,
    suppliedBody?: Uint8Array,
  ): Promise<TestCommandRecord> {
    const command = await this.#repository.getTestCommand(commandId);
    if (command === undefined) {
      throw new ReferenceApiError(
        404,
        "TEST_COMMAND_NOT_FOUND",
        "The test command was not found.",
      );
    }
    if (command.evidenceState === "complete") {
      return command;
    }
    const result = command.pendingResult;
    const observedAt = command.resultObservedAt;
    if (result === undefined || observedAt === undefined) {
      throw new Error("The test command has no staged completion evidence.");
    }
    const body =
      suppliedBody === undefined
        ? await this.#testBody(command)
        : Buffer.from(suppliedBody);
    if (sha256(body) !== command.context.bodySha256) {
      throw new Error(
        "The supplied test body does not match its request context.",
      );
    }
    const status: MetadataDeliveryAttemptInput["status"] =
      result.state === "acknowledged"
        ? "delivered"
        : result.state === "unknown"
          ? "unknown"
          : "failed";
    const input: MetadataDeliveryAttemptInput = {
      attempt: 1,
      deliveryId: command.id,
      endpointId: command.endpointId,
      eventId: result.messageId ?? command.id,
      eventVersion: {
        eventType: command.eventType,
        schemaChecksum: command.context.schemaChecksum,
        version: command.context.eventVersion,
      },
      kind: "delivery_attempt",
      mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
      occurredAt: observedAt,
      schemaVersion: "2026-07-01",
      sequence: 1,
      status,
      ...(result.statusCode === undefined
        ? {}
        : { responseStatusCode: result.statusCode }),
      ...(result.errorCategory === undefined
        ? {}
        : { errorCode: result.errorCategory }),
    };
    const record = canonicalizeMetadataRecord(
      input,
      this.#config.metadataIdentity,
    );
    const payload = command.context.payload;
    let uploadAttempt: CreatePayloadUploadIntentInput | undefined;
    let uploaded = false;
    if (payload !== undefined) {
      const createdAt = this.#nowIso();
      const uploadAttemptId = this.#idFactory();
      const uploadGeneration = this.#idFactory();
      const objectKey = [
        "payloads",
        "local",
        encodeURIComponent(command.endpointId),
        encodeURIComponent(command.id),
        encodeURIComponent(uploadAttemptId),
        encodeURIComponent(uploadGeneration),
      ].join("/");
      uploadAttempt = {
        id: uploadAttemptId,
        uploadAttemptId,
        uploadGeneration,
        objectKey,
        contentType: payload.contentType,
        size: payload.size,
        createdAt,
        expiresAt: new Date(
          Date.parse(createdAt) + payload.ttlSeconds * 1000,
        ).toISOString(),
        endpointId: command.endpointId,
        deliveryId: command.id,
      };
      try {
        await this.#repository.createPayloadUploadIntent(uploadAttempt);
      } catch (error) {
        if (error instanceof PayloadCleanupConflictError) {
          throw payloadCleanupApiError(error);
        }
        throw error;
      }
      try {
        await this.#payloadStorage.put({
          objectKey: uploadAttempt.objectKey,
          bytes: body,
          contentType: uploadAttempt.contentType,
          createdAt: uploadAttempt.createdAt,
          expiresAt: uploadAttempt.expiresAt,
        });
        uploaded = true;
      } catch (error) {
        if (error instanceof PayloadCleanupConflictError) {
          throw payloadCleanupApiError(error);
        }
        try {
          await this.#payloadStorage.delete(uploadAttempt.objectKey);
          await this.#repository.completePayloadUploadIntent(
            uploadAttempt.id,
            uploadAttempt.uploadGeneration,
          );
        } catch (cleanupError) {
          try {
            await this.#repository.markPayloadUploadIntentOrphaned(
              uploadAttempt.id,
              uploadAttempt.uploadGeneration,
              this.#nowIso(),
              cleanupError instanceof Error
                ? cleanupError.name
                : "payload_cleanup_failed",
            );
          } catch (markError) {
            throw new AggregateError(
              [error, cleanupError, markError],
              "Payload upload failed and its durable orphan state could not be updated.",
            );
          }
          throw new AggregateError(
            [error, cleanupError],
            "Payload upload failed and compensation remains pending.",
          );
        }
        throw error;
      }
    }
    try {
      return await this.#repository.transaction(async (repository) => {
        await repository.acquireTimelineEvidenceLocks({
          commandIds: [commandId],
          records: [record],
        });
        const endpoint = await repository.lockEndpoint(command.endpointId);
        if (endpoint === undefined || endpoint.state === "deleted") {
          throw new Error(
            "The endpoint was deleted during test evidence completion.",
          );
        }
        const current = await repository.lockTestCommand(commandId);
        if (current === undefined) {
          throw new Error("The test command disappeared during completion.");
        }
        if (current.evidenceState === "complete") {
          return current;
        }
        if (
          current.pendingResult === undefined ||
          current.resultObservedAt === undefined
        ) {
          throw new Error("The staged test result disappeared.");
        }
        await repository.ingestMetadata([record], observedAt);
        if (uploadAttempt !== undefined) {
          await repository.createPayloadReference({
            id: uploadAttempt.id,
            uploadAttemptId: uploadAttempt.uploadAttemptId,
            uploadGeneration: uploadAttempt.uploadGeneration,
            objectKey: uploadAttempt.objectKey,
            contentType: uploadAttempt.contentType,
            size: uploadAttempt.size,
            createdAt: uploadAttempt.createdAt,
            expiresAt: uploadAttempt.expiresAt,
            endpointId: current.endpointId,
            deliveryId: current.id,
          });
          await repository.completePayloadUploadIntent(
            uploadAttempt.id,
            uploadAttempt.uploadGeneration,
          );
        }
        const completed = await repository.completeTestCommand(
          commandId,
          this.#nowIso(),
        );
        if (completed === undefined || completed.result === undefined) {
          throw new Error("The test command did not complete.");
        }
        await this.#audit(
          {
            action: "test.send",
            resourceType: "test_command",
            resourceId: completed.id,
            result:
              completed.result.state === "acknowledged"
                ? "success"
                : completed.result.state === "unknown"
                  ? "unknown"
                  : completed.result.state === "rejected_before_dispatch"
                    ? "denied"
                    : "failure",
            correlationId,
            details: {
              endpointId: completed.endpointId,
              eventType: completed.eventType,
              state: completed.result.state,
              releaseId: completed.context.releaseId,
              ...(completed.result.statusCode === undefined
                ? {}
                : { statusCode: completed.result.statusCode }),
            },
          },
          repository,
        );
        await this.#outbox(
          {
            topic: "test.completed",
            aggregateType: "test_command",
            aggregateId: completed.id,
            correlationId,
            payload: {
              state: completed.result.state,
              deliveryId: completed.id,
              payloadRetained: payload !== undefined,
            },
          },
          repository,
        );
        return completed;
      });
    } catch (error) {
      if (error instanceof PayloadCleanupConflictError) {
        throw payloadCleanupApiError(error);
      }
      try {
        const persisted = await this.#repository.getTestCommand(commandId);
        const payloadReference =
          uploadAttempt === undefined
            ? undefined
            : await this.#repository.getPayloadReference(uploadAttempt.id);
        const uploadIntent =
          uploadAttempt === undefined
            ? undefined
            : await this.#repository.getPayloadUploadIntent(uploadAttempt.id);
        if (
          persisted?.evidenceState === "complete" &&
          (uploadAttempt === undefined ||
            (payloadReference !== undefined && uploadIntent === undefined))
        ) {
          return persisted;
        }
        if (
          persisted?.evidenceState === "complete" ||
          payloadReference !== undefined
        ) {
          throw new Error(
            "Test completion evidence is partially persisted after an ambiguous transaction outcome.",
          );
        }
      } catch (verificationError) {
        throw new AggregateError(
          [error, verificationError],
          "Test evidence transaction outcome is unknown; payload compensation was not attempted.",
        );
      }
      if (uploaded && uploadAttempt !== undefined) {
        try {
          await this.#payloadStorage.delete(uploadAttempt.objectKey);
          await this.#repository.completePayloadUploadIntent(
            uploadAttempt.id,
            uploadAttempt.uploadGeneration,
          );
        } catch (cleanupError) {
          try {
            await this.#repository.markPayloadUploadIntentOrphaned(
              uploadAttempt.id,
              uploadAttempt.uploadGeneration,
              this.#nowIso(),
              cleanupError instanceof Error
                ? cleanupError.name
                : "payload_cleanup_failed",
            );
          } catch (markError) {
            throw new AggregateError(
              [error, cleanupError, markError],
              "Test evidence persistence failed and payload orphan state could not be updated.",
            );
          }
          throw new AggregateError(
            [error, cleanupError],
            "Test evidence persistence failed and payload compensation remains pending.",
          );
        }
      }
      throw error;
    }
  }

  async verifyEndpointWebhook(
    endpointId: string,
    body: Uint8Array,
    headers: WebhookHeadersInput,
  ): Promise<VerificationResult> {
    const secrets = await this.#eligibleSecrets(endpointId);
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
      clock: this.#clock,
      toleranceSeconds: 300,
    });
  }

  createMetadataEnvelope(
    records: readonly MetadataDeliveryAttemptInput[],
    batchId: string,
  ): AuthenticatedMetadataIngestEnvelope {
    return createAuthenticatedMetadataIngestEnvelope(
      records,
      this.#config.metadataIdentity,
      batchId,
      this.#ingestCredential,
      { issuedAt: this.#nowMilliseconds() },
    );
  }

  async ingestMetadataEnvelope(
    envelope: unknown,
    correlationId: string,
  ): Promise<MetadataIngestSummary> {
    const verifier = createMetadataIngestVerifier({
      credential: this.#ingestCredential,
      identity: this.#config.metadataIdentity,
      clock: () => this.#nowMilliseconds(),
    });
    const verified = verifier.verify(envelope);
    if (!verified.ok) {
      await this.#audit({
        action: "metadata.ingest",
        resourceType: "metadata_batch",
        result: "denied",
        correlationId,
        details: { code: verified.code },
      });
      throw new ReferenceApiError(
        401,
        "INVALID_METADATA_SIGNATURE",
        "The metadata envelope could not be authenticated.",
      );
    }
    const summary = await this.#repository.ingestMetadata(
      verified.records,
      this.#nowIso(),
    );
    await this.#audit({
      action: "metadata.ingest",
      resourceType: "metadata_batch",
      resourceId: verified.envelope.batchId,
      result: "success",
      correlationId,
      details: {
        accepted: summary.accepted,
        duplicates: summary.duplicates,
        late: summary.late,
      },
    });
    return summary;
  }

  async listTimeline(
    filters: TimelineFilters,
    correlationId?: string,
  ): Promise<TimelinePage> {
    let page: TimelinePage;
    try {
      page = await this.#repository.listTimeline(filters);
    } catch (error) {
      if (error instanceof InvalidTimelineCursorError) {
        throw new ReferenceApiError(
          400,
          "INVALID_CURSOR",
          "The timeline cursor is invalid.",
        );
      }
      throw error;
    }
    if (correlationId !== undefined) {
      await this.#audit({
        action: "timeline.read",
        resourceType: "timeline",
        result: "success",
        correlationId,
        details: { resultCount: page.items.length },
      });
    }
    return page;
  }

  async listAudit(
    limit: number,
    correlationId?: string,
  ): Promise<readonly AuditRecord[]> {
    if (correlationId !== undefined) {
      await this.#audit({
        action: "audit.read",
        resourceType: "audit",
        result: "success",
        correlationId,
        details: { limit },
      });
    }
    return this.#repository.listAudit(limit);
  }

  get repository(): ReferenceRepository {
    return this.#repository;
  }
}
