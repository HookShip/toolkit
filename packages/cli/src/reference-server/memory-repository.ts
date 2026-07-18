// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

import {
  reduceDeliveryAttempt,
  type CanonicalMetadataRecord,
} from "@webhook-portal/adapter-sdk";

import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  timelineEntryIsAfterCursor,
} from "./cursor.js";
import { metadataTimelineIdentityKey, referenceSha256 } from "./crypto.js";
import {
  EXPECTED_REFERENCE_SCHEMA_VERSION,
  REFERENCE_SERVER_MIGRATIONS,
} from "./migrations.js";
import { compareCodeUnits, compareNumbers } from "./ordering.js";
import {
  PayloadCleanupConflictError,
  RepositoryCommitUncertainError,
} from "./repository-errors.js";
import { releaseMetadata } from "./release-metadata.js";
import type {
  AuditRecord,
  BeginPayloadCleanupDeletionInput,
  BeginPayloadCleanupDeletionResult,
  BeginTestCommandResult,
  ClaimPayloadCleanupInput,
  ClaimPayloadCleanupResult,
  ContractImportRecord,
  CreateEndpointInput,
  CreatePayloadReferenceInput,
  CreatePayloadUploadIntentInput,
  DeletePayloadReferenceInput,
  CreateSecretVersionInput,
  CreateTestCommandInput,
  EndpointDeletionResult,
  EndpointRecord,
  EndpointTombstone,
  FinalizePayloadCleanupDeletionInput,
  MetadataIngestSummary,
  OutboxRecord,
  PayloadCleanupTask,
  PayloadCleanupClaim,
  PayloadPage,
  PayloadReference,
  PayloadStorageNamespaceState,
  PayloadUploadIntent,
  PublishStatus,
  PublishCommandRecord,
  PublishReleaseInput,
  ReferenceRepository,
  ReferenceRepositoryTransaction,
  ReleasePayloadCleanupClaimInput,
  ReleaseRecord,
  ReleaseMetadata,
  ReleaseMetadataPage,
  RepositoryReadiness,
  RotateSecretInput,
  SecretVersionRecord,
  SetSubscriptionInput,
  SubscriptionRecord,
  TestCommandRecord,
  TestCommandResult,
  TimelineEntry,
  TimelineEvidenceLockInput,
  TimelineFilters,
  TimelinePage,
  UpdateEndpointInput,
} from "./types.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

interface MetadataObservationState {
  readonly identityKey: string;
  readonly record: CanonicalMetadataRecord;
}

interface MemoryState {
  imports: Map<string, ContractImportRecord>;
  releases: Map<string, ReleaseRecord>;
  releaseMetadata: Map<string, ReleaseMetadata>;
  activeReleaseId?: string;
  nextReleaseSequence: number;
  publishCommands: Map<string, PublishCommandRecord>;
  endpoints: Map<string, EndpointRecord>;
  subscriptions: Map<string, SubscriptionRecord>;
  secrets: Map<string, SecretVersionRecord>;
  commands: Map<string, TestCommandRecord>;
  commandKeys: Map<string, string>;
  metadataObservations: Map<string, MetadataObservationState>;
  timeline: Map<string, TimelineEntry>;
  audit: AuditRecord[];
  outbox: OutboxRecord[];
  payloads: Map<string, PayloadReference>;
  payloadUploadIntents: Map<string, PayloadUploadIntent>;
  payloadCleanupClaims: Map<string, PayloadCleanupClaim>;
  payloadCleanupTasks: Map<string, PayloadCleanupTask>;
  payloadStorageNamespace?: PayloadStorageNamespaceState;
}

function createState(): MemoryState {
  return {
    imports: new Map(),
    releases: new Map(),
    releaseMetadata: new Map(),
    nextReleaseSequence: 1,
    publishCommands: new Map(),
    endpoints: new Map(),
    subscriptions: new Map(),
    secrets: new Map(),
    commands: new Map(),
    commandKeys: new Map(),
    metadataObservations: new Map(),
    timeline: new Map(),
    audit: [],
    outbox: [],
    payloads: new Map(),
    payloadUploadIntents: new Map(),
    payloadCleanupClaims: new Map(),
    payloadCleanupTasks: new Map(),
  };
}

class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function commandKey(endpointId: string, idempotencyKey: string): string {
  return `${endpointId}\n${idempotencyKey}`;
}

function activeRelease(
  record: ReleaseRecord,
  activeReleaseId: string | undefined,
): ReleaseRecord {
  return { ...copy(record), active: record.id === activeReleaseId };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface InMemoryReferenceRepositoryOptions {
  readonly faultInjector?: (operation: string) => Promise<void> | void;
}

export class InMemoryReferenceRepository implements ReferenceRepository {
  readonly #transactions = new AsyncLocalStorage<MemoryState>();
  readonly #mutex = new AsyncMutex();
  readonly #faultInjector:
    ((operation: string) => Promise<void> | void) | undefined;
  #state = createState();
  #closed = false;

  constructor(options: InMemoryReferenceRepositoryOptions = {}) {
    this.#faultInjector = options.faultInjector;
  }

  async #fault(operation: string): Promise<void> {
    await this.#faultInjector?.(operation);
  }

  async #withState<T>(
    operation: (state: MemoryState) => Promise<T>,
  ): Promise<T> {
    const transaction = this.#transactions.getStore();
    if (transaction !== undefined) {
      return operation(transaction);
    }
    return this.#mutex.run(() => operation(this.#state));
  }

  async transaction<T>(
    callback: (transaction: ReferenceRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.#transactions.getStore() !== undefined) {
      return callback(this);
    }
    return this.#mutex.run(async () => {
      const working = copy(this.#state);
      const result = await this.#transactions.run(working, () =>
        callback(this),
      );
      this.#state = working;
      try {
        await this.#fault("transactionCommitResponse");
      } catch (error) {
        throw new RepositoryCommitUncertainError(error);
      }
      return result;
    });
  }

  async readiness(): Promise<RepositoryReadiness> {
    if (this.#closed) {
      throw new Error("Repository is closed.");
    }
    return {
      ready: true,
      expectedSchemaVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
      appliedSchemaVersions: REFERENCE_SERVER_MIGRATIONS.map(
        (entry) => entry.version,
      ),
      currentSchemaVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
      missingSchemaVersions: [],
      unexpectedSchemaVersions: [],
      checksumMismatches: [],
    };
  }

  async ping(): Promise<void> {
    await this.readiness();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async createContractImport(record: ContractImportRecord): Promise<void> {
    await this.#withState(async (state) => {
      await this.#fault("createContractImport");
      if (state.imports.has(record.id)) {
        throw new Error(`Contract import "${record.id}" already exists.`);
      }
      state.imports.set(record.id, copy(record));
    });
  }

  async getContractImport(
    id: string,
  ): Promise<ContractImportRecord | undefined> {
    return this.#withState(async (state) => {
      const value = state.imports.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async lockReleaseState(): Promise<ReleaseRecord | undefined> {
    return this.getActiveRelease();
  }

  async publishRelease(input: PublishReleaseInput): Promise<ReleaseRecord> {
    return this.#withState(async (state) => {
      await this.#fault("publishRelease");
      const contract = input.importRecord.contract;
      const canonicalExport = input.importRecord.canonicalExport;
      if (contract === undefined || canonicalExport === undefined) {
        throw new Error(
          "Cannot publish an import without a canonical contract.",
        );
      }
      if (state.releases.has(input.id)) {
        throw new Error(`Release "${input.id}" already exists.`);
      }
      const stored: ReleaseRecord = {
        id: input.id,
        importId: input.importRecord.id,
        sequence: state.nextReleaseSequence,
        createdAt: input.createdAt,
        active: false,
        checksum: contract.checksum.value,
        contract: copy(contract),
        canonicalExport: copy(canonicalExport),
        changelog: copy(input.changelog),
        ...(input.compatibility === undefined
          ? {}
          : { compatibility: copy(input.compatibility) }),
        ...(input.overrideReason === undefined
          ? {}
          : { overrideReason: input.overrideReason }),
      };
      if (state.activeReleaseId !== undefined) {
        const previous = state.releaseMetadata.get(state.activeReleaseId);
        if (previous !== undefined) {
          state.releaseMetadata.set(previous.id, {
            ...previous,
            status: "superseded",
          });
        }
      }
      state.nextReleaseSequence += 1;
      state.releases.set(stored.id, stored);
      state.activeReleaseId = stored.id;
      const active = activeRelease(stored, state.activeReleaseId);
      state.releaseMetadata.set(stored.id, releaseMetadata(active));
      return active;
    });
  }

  async getActiveRelease(): Promise<ReleaseRecord | undefined> {
    return this.#withState(async (state) => {
      if (state.activeReleaseId === undefined) {
        return undefined;
      }
      const value = state.releases.get(state.activeReleaseId);
      return value === undefined
        ? undefined
        : activeRelease(value, state.activeReleaseId);
    });
  }

  async getRelease(id: string): Promise<ReleaseRecord | undefined> {
    return this.#withState(async (state) => {
      const value = state.releases.get(id);
      return value === undefined
        ? undefined
        : activeRelease(value, state.activeReleaseId);
    });
  }

  async listReleases(): Promise<readonly ReleaseRecord[]> {
    return this.#withState(async (state) =>
      [...state.releases.values()]
        .sort((left, right) => compareNumbers(right.sequence, left.sequence))
        .map((record) => activeRelease(record, state.activeReleaseId)),
    );
  }

  async listReleaseMetadataPage(
    limit: number,
    beforeSequence?: number,
  ): Promise<ReleaseMetadataPage> {
    return this.#withState(async (state) => {
      const matches = [...state.releaseMetadata.values()]
        .filter(
          (release) =>
            beforeSequence === undefined ||
            compareNumbers(release.sequence, beforeSequence) < 0,
        )
        .sort((left, right) => compareNumbers(right.sequence, left.sequence))
        .slice(0, limit + 1);
      const items = matches.slice(0, limit).map(copy);
      const last = items.at(-1);
      return {
        items,
        ...(matches.length > limit && last !== undefined
          ? { nextBeforeSequence: last.sequence }
          : {}),
      };
    });
  }

  async createPublishCommand(record: PublishCommandRecord): Promise<void> {
    await this.#withState(async (state) => {
      await this.#fault("createPublishCommand");
      if (state.publishCommands.has(record.idempotencyKey)) {
        throw new Error(
          `Publish idempotency key "${record.idempotencyKey}" already exists.`,
        );
      }
      state.publishCommands.set(record.idempotencyKey, copy(record));
    });
  }

  async getPublishCommand(
    idempotencyKey: string,
  ): Promise<PublishCommandRecord | undefined> {
    return this.#withState(async (state) => {
      const value = state.publishCommands.get(idempotencyKey);
      return value === undefined ? undefined : copy(value);
    });
  }

  async getPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    const command = await this.getPublishCommand(idempotencyKey);
    if (command === undefined) {
      return { status: "not_found", idempotencyKey };
    }
    if (command.state !== "completed" || command.releaseId === undefined) {
      return { status: "pending", idempotencyKey, command };
    }
    const release = await this.getRelease(command.releaseId);
    return release === undefined
      ? {
          status: "inconsistent",
          idempotencyKey,
          command,
          reason: "release_not_found",
        }
      : { status: "completed", idempotencyKey, command, release };
  }

  async recoverPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    await this.#fault("recoverPublishStatus");
    return this.getPublishStatus(idempotencyKey);
  }

  async completePublishCommand(
    id: string,
    releaseId: string,
    predecessorReleaseId: string | undefined,
    timestamp: string,
  ): Promise<PublishCommandRecord> {
    return this.#withState(async (state) => {
      await this.#fault("completePublishCommand");
      const entry = [...state.publishCommands.entries()].find(
        ([, command]) => command.id === id,
      );
      if (entry === undefined) {
        throw new Error(`Publish command "${id}" was not found.`);
      }
      const [key, current] = entry;
      if (current.state === "completed") {
        if (current.releaseId !== releaseId) {
          throw new Error("A completed publish command cannot be changed.");
        }
        return copy(current);
      }
      const next: PublishCommandRecord = {
        ...current,
        state: "completed",
        releaseId,
        updatedAt: timestamp,
        ...(predecessorReleaseId === undefined ? {} : { predecessorReleaseId }),
      };
      state.publishCommands.set(key, next);
      return copy(next);
    });
  }

  async createEndpoint(input: CreateEndpointInput): Promise<EndpointRecord> {
    return this.#withState(async (state) => {
      await this.#fault("createEndpoint");
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
    return this.#withState(async (state) => {
      const value = state.endpoints.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async lockEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return this.getEndpoint(id);
  }

  async listEndpoints(): Promise<readonly EndpointRecord[]> {
    return this.#withState(async (state) =>
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
    return this.#withState(async (state) => {
      await this.#fault("updateEndpoint");
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
    return this.#withState(async (state) => {
      await this.#fault("deleteEndpointData");
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
    return this.#withState(async (state) => {
      await this.#fault("setSubscription");
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
    return this.#withState(async (state) => {
      const value = state.subscriptions.get(endpointId);
      return value === undefined ? undefined : copy(value);
    });
  }

  async createSecretVersion(
    input: CreateSecretVersionInput,
  ): Promise<SecretVersionRecord> {
    return this.#withState(async (state) => {
      await this.#fault("createSecretVersion");
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
    return this.#withState(async (state) => {
      await this.#fault("rotateSecret");
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
    return this.#withState(async (state) => {
      await this.#fault("revokeSecret");
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
    return this.#withState(async (state) => {
      const value = state.secrets.get(secretId);
      return value === undefined || value.endpointId !== endpointId
        ? undefined
        : copy(value);
    });
  }

  async listSecretVersions(
    endpointId: string,
  ): Promise<readonly SecretVersionRecord[]> {
    return this.#withState(async (state) =>
      [...state.secrets.values()]
        .filter((secret) => secret.endpointId === endpointId)
        .sort((left, right) =>
          compareCodeUnits(right.createdAt, left.createdAt),
        )
        .map(copy),
    );
  }

  async beginTestCommand(
    input: CreateTestCommandInput,
  ): Promise<BeginTestCommandResult> {
    return this.#withState(async (state) => {
      await this.#fault("beginTestCommand");
      const compound = commandKey(input.endpointId, input.idempotencyKey);
      const existingId = state.commandKeys.get(compound);
      if (existingId !== undefined) {
        const existing = state.commands.get(existingId);
        if (existing === undefined) {
          throw new Error("Command index is inconsistent.");
        }
        return {
          status:
            existing.requestFingerprint === input.requestFingerprint
              ? "existing"
              : "conflict",
          command: copy(existing),
        };
      }
      const command: TestCommandRecord = {
        id: input.id,
        endpointId: input.endpointId,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        state: "requested",
        evidenceState: "pending",
        context: copy(input.context),
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      };
      state.commands.set(command.id, command);
      state.commandKeys.set(compound, command.id);
      return { status: "created", command: copy(command) };
    });
  }

  async getTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return this.#withState(async (state) => {
      const value = state.commands.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async getTestCommandByIdempotency(
    endpointId: string,
    idempotencyKey: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#withState(async (state) => {
      const id = state.commandKeys.get(commandKey(endpointId, idempotencyKey));
      const value = id === undefined ? undefined : state.commands.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async lockTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return this.getTestCommand(id);
  }

  async markTestCommandDispatched(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#withState(async (state) => {
      await this.#fault("markTestCommandDispatched");
      const current = state.commands.get(id);
      if (current === undefined) {
        return undefined;
      }
      if (
        current.state !== "requested" ||
        current.pendingResult !== undefined
      ) {
        return copy(current);
      }
      const next: TestCommandRecord = {
        ...current,
        state: "dispatched",
        dispatchedAt: timestamp,
        updatedAt: timestamp,
      };
      state.commands.set(id, next);
      return copy(next);
    });
  }

  async stageTestCommandResult(
    id: string,
    timestamp: string,
    result: TestCommandResult,
  ): Promise<TestCommandRecord | undefined> {
    return this.#withState(async (state) => {
      await this.#fault("stageTestCommandResult");
      const current = state.commands.get(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.evidenceState === "complete") {
        return copy(current);
      }
      if (
        current.pendingResult !== undefined &&
        !sameJson(current.pendingResult, result)
      ) {
        throw new Error("A staged test result cannot be overwritten.");
      }
      const next: TestCommandRecord = {
        ...current,
        evidenceState: "pending",
        pendingResult: copy(current.pendingResult ?? result),
        resultObservedAt: current.resultObservedAt ?? timestamp,
        updatedAt: timestamp,
      };
      state.commands.set(id, next);
      return copy(next);
    });
  }

  async completeTestCommand(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#withState(async (state) => {
      await this.#fault("completeTestCommand");
      const current = state.commands.get(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.evidenceState === "complete") {
        return copy(current);
      }
      if (current.pendingResult === undefined) {
        throw new Error(
          "A test command cannot complete without a staged result.",
        );
      }
      const { pendingResult, ...withoutPending } = current;
      const next: TestCommandRecord = {
        ...withoutPending,
        state: pendingResult.state,
        evidenceState: "complete",
        result: copy(pendingResult),
        updatedAt: timestamp,
      };
      state.commands.set(id, next);
      return copy(next);
    });
  }

  async acquireTimelineEvidenceLocks(
    input: TimelineEvidenceLockInput,
  ): Promise<void> {
    void input;
  }

  async ingestMetadata(
    records: readonly CanonicalMetadataRecord[],
    ingestedAt: string,
  ): Promise<MetadataIngestSummary> {
    return this.transaction(async () =>
      this.#withState(async (state) => {
        await this.#fault("ingestMetadata");
        let accepted = 0;
        let duplicates = 0;
        let late = 0;
        for (const record of records) {
          const endpoint = state.endpoints.get(record.endpointId);
          if (endpoint?.state === "deleted") {
            throw new Error(
              "Metadata cannot be ingested for a deleted endpoint.",
            );
          }
          if (state.metadataObservations.has(record.dedupeKey)) {
            duplicates += 1;
            continue;
          }
          const identityKey = metadataTimelineIdentityKey(record);
          const current = state.timeline.get(identityKey);
          const isLate =
            current !== undefined &&
            (record.sequence < current.current.sequence ||
              record.occurredAt < current.current.occurredAt);
          const reduction = reduceDeliveryAttempt(
            current?.reduction,
            copy(record),
          );
          state.metadataObservations.set(record.dedupeKey, {
            identityKey,
            record: copy(record),
          });
          state.timeline.set(identityKey, {
            deliveryId: record.deliveryId,
            current: copy(reduction.current),
            reduction: copy(reduction),
            firstIngestedAt: current?.firstIngestedAt ?? ingestedAt,
            lastIngestedAt: ingestedAt,
            observationCount: (current?.observationCount ?? 0) + 1,
            lateObservationCount:
              (current?.lateObservationCount ?? 0) + (isLate ? 1 : 0),
            payloadRetained: current?.payloadRetained ?? false,
          });
          accepted += 1;
          late += isLate ? 1 : 0;
        }
        return { accepted, duplicates, late };
      }),
    );
  }

  async listTimeline(filters: TimelineFilters): Promise<TimelinePage> {
    return this.#withState(async (state) => {
      const cursor =
        filters.cursor === undefined
          ? undefined
          : decodeTimelineCursor(filters.cursor);
      const items = [...state.timeline.values()]
        .filter((entry) => {
          const record = entry.current;
          return (
            (filters.deliveryId === undefined ||
              entry.deliveryId === filters.deliveryId) &&
            (filters.endpointId === undefined ||
              record.endpointId === filters.endpointId) &&
            (filters.eventId === undefined ||
              record.eventId === filters.eventId) &&
            (filters.eventType === undefined ||
              record.eventVersion.eventType === filters.eventType) &&
            (filters.status === undefined ||
              record.status === filters.status) &&
            (filters.from === undefined || record.occurredAt >= filters.from) &&
            (filters.to === undefined || record.occurredAt <= filters.to) &&
            (cursor === undefined || timelineEntryIsAfterCursor(entry, cursor))
          );
        })
        .sort((left, right) => {
          const time = compareCodeUnits(
            right.lastIngestedAt,
            left.lastIngestedAt,
          );
          return time === 0
            ? compareCodeUnits(
                metadataTimelineIdentityKey(right.current),
                metadataTimelineIdentityKey(left.current),
              )
            : time;
        });
      const page = items.slice(0, filters.limit).map(copy);
      const hasMore = filters.limit < items.length;
      return {
        items: page,
        ...(hasMore && page.length > 0
          ? { nextCursor: encodeTimelineCursor(page[page.length - 1]!) }
          : {}),
      };
    });
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.#withState(async (state) => {
      await this.#fault("appendAudit");
      if (state.audit.some((existing) => existing.id === record.id)) {
        throw new Error(`Audit event "${record.id}" already exists.`);
      }
      state.audit.push(copy(record));
    });
  }

  async listAudit(limit: number): Promise<readonly AuditRecord[]> {
    return this.#withState(async (state) =>
      state.audit.slice(-limit).reverse().map(copy),
    );
  }

  async appendOutbox(record: OutboxRecord): Promise<void> {
    await this.#withState(async (state) => {
      await this.#fault("appendOutbox");
      if (state.outbox.some((existing) => existing.id === record.id)) {
        throw new Error(`Outbox event "${record.id}" already exists.`);
      }
      state.outbox.push(copy(record));
    });
  }

  async listOutbox(limit: number): Promise<readonly OutboxRecord[]> {
    return this.#withState(async (state) =>
      state.outbox.slice(-limit).reverse().map(copy),
    );
  }

  async createPayloadReference(
    input: CreatePayloadReferenceInput,
  ): Promise<void> {
    await this.#withState(async (state) => {
      await this.#fault("createPayloadReference");
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
    return this.#withState(async (state) => {
      const value = state.payloads.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async getPayloadReferenceByObjectKey(
    objectKey: string,
  ): Promise<PayloadReference | undefined> {
    return this.#withState(async (state) => {
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
    return this.#withState(async (state) => {
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
    return this.#withState(async (state) => {
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
    await this.#withState(async (state) => {
      await this.#fault("deletePayloadReference");
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
    return this.#withState(async (state) => {
      await this.#fault("createPayloadUploadIntent");
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
    return this.#withState(async (state) => {
      const value = state.payloadUploadIntents.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async getPayloadUploadIntentByObjectKey(
    objectKey: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return this.#withState(async (state) => {
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
    return this.#withState(async (state) => {
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
    await this.#withState(async (state) => {
      await this.#fault("markPayloadUploadIntentOrphaned");
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
    await this.#withState(async (state) => {
      await this.#fault("completePayloadUploadIntent");
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

  async claimPayloadCleanup(
    input: ClaimPayloadCleanupInput,
  ): Promise<ClaimPayloadCleanupResult> {
    return this.#withState(async (state) => {
      await this.#fault("claimPayloadCleanup");
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
    return this.#withState(async (state) => {
      await this.#fault("beginPayloadCleanupDeletion");
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
    return this.#withState(async (state) => {
      await this.#fault("finalizePayloadCleanupDeletion");
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
    return this.#withState(async (state) => {
      await this.#fault("releasePayloadCleanupClaim");
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
    return this.#withState(async (state) => {
      const claim = state.payloadCleanupClaims.get(objectKey);
      return claim === undefined ? undefined : copy(claim);
    });
  }

  async listExpiredPayloadCleanupClaims(
    now: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadCleanupClaim>> {
    return this.#withState(async (state) => {
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

  async getPayloadStorageNamespace(): Promise<
    PayloadStorageNamespaceState | undefined
  > {
    return this.#withState(async (state) =>
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
    return this.#withState(async (state) => {
      await this.#fault("initializePayloadStorageNamespace");
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
    return this.#withState(async (state) => {
      await this.#fault("markPayloadStorageNamespaceReady");
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
    return this.#withState(async (state) =>
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

  async listPayloadCleanupTasks(
    limit: number,
    endpointId?: string,
    cursor?: string,
  ): Promise<readonly PayloadCleanupTask[]> {
    return this.#withState(async (state) =>
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
    await this.#withState(async (state) => {
      await this.#fault("markPayloadCleanupFailed");
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
    await this.#withState(async (state) => {
      await this.#fault("completePayloadCleanup");
      state.payloadCleanupTasks.delete(id);
    });
  }
}
