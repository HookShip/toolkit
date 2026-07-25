// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

import type { CanonicalMetadataRecord } from "@webhook-portal/adapter-sdk";

import {
  EXPECTED_REFERENCE_SCHEMA_VERSION,
  REFERENCE_SERVER_MIGRATIONS,
} from "../migrations.js";
import { RepositoryCommitUncertainError } from "../repository-errors.js";
import type {
  AuditRecord,
  ContractImportRecord,
  EndpointRecord,
  OutboxRecord,
  PayloadCleanupClaim,
  PayloadCleanupTask,
  PayloadReference,
  PayloadStorageNamespaceState,
  PayloadUploadIntent,
  PublishCommandRecord,
  ReferenceRepository,
  ReferenceRepositoryTransaction,
  ReleaseMetadata,
  ReleaseRecord,
  RepositoryReadiness,
  SecretVersionRecord,
  SubscriptionRecord,
  TestCommandRecord,
  TimelineEntry,
} from "../types.js";

export function copy<T>(value: T): T {
  return structuredClone(value);
}

interface MetadataObservationState {
  readonly identityKey: string;
  readonly record: CanonicalMetadataRecord;
}

export interface MemoryState {
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

export function commandKey(endpointId: string, idempotencyKey: string): string {
  return `${endpointId}
${idempotencyKey}`;
}

export function activeRelease(
  record: ReleaseRecord,
  activeReleaseId: string | undefined,
): ReleaseRecord {
  return { ...copy(record), active: record.id === activeReleaseId };
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface InMemoryReferenceRepositoryOptions {
  readonly faultInjector?: (operation: string) => Promise<void> | void;
}

export class InMemoryRepositoryState {
  readonly #transactions = new AsyncLocalStorage<MemoryState>();
  readonly #mutex = new AsyncMutex();
  readonly #faultInjector:
    ((operation: string) => Promise<void> | void) | undefined;
  #state = createState();
  #closed = false;
  #repository: ReferenceRepository | undefined;

  constructor(options: InMemoryReferenceRepositoryOptions = {}) {
    this.#faultInjector = options.faultInjector;
  }

  attach(repository: ReferenceRepository): void {
    this.#repository = repository;
  }

  get repository(): ReferenceRepository {
    if (this.#repository === undefined) {
      throw new Error("Repository state is not attached.");
    }
    return this.#repository;
  }

  async fault(operation: string): Promise<void> {
    await this.#faultInjector?.(operation);
  }

  async withState<T>(
    operation: (state: MemoryState) => Promise<T>,
  ): Promise<T> {
    const transaction = this.#transactions.getStore();
    if (transaction !== undefined) {
      return operation(transaction);
    }
    return this.#mutex.run(() => operation(this.#state));
  }

  async transaction<T>(
    repository: ReferenceRepositoryTransaction,
    callback: (transaction: ReferenceRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.#transactions.getStore() !== undefined) {
      return callback(repository);
    }
    return this.#mutex.run(async () => {
      const working = copy(this.#state);
      const result = await this.#transactions.run(working, () =>
        callback(repository),
      );
      this.#state = working;
      try {
        await this.fault("transactionCommitResponse");
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
    if (this.#closed) {
      throw new Error("Repository is closed.");
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}
