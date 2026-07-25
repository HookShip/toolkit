// SPDX-License-Identifier: Apache-2.0

import type {
  BeginPayloadCleanupDeletionInput,
  BeginPayloadCleanupDeletionResult,
  ClaimPayloadCleanupInput,
  ClaimPayloadCleanupResult,
  CreatePayloadReferenceInput,
  CreatePayloadUploadIntentInput,
  DeletePayloadReferenceInput,
  FinalizePayloadCleanupDeletionInput,
  IsoTimestamp,
  PayloadCleanupClaim,
  PayloadCleanupTask,
  PayloadPage,
  PayloadReference,
  PayloadRepository,
  PayloadStorageNamespaceState,
  PayloadUploadIntent,
  ReleasePayloadCleanupClaimInput,
} from "../types.js";
import type { InMemoryPayloadCleanupRepository } from "./memory-payload-cleanup-repository.js";
import type { InMemoryPayloadNamespaceRepository } from "./memory-payload-namespace-repository.js";
import type { InMemoryPayloadReferenceRepository } from "./memory-payload-reference-repository.js";

export class InMemoryPayloadRepository implements PayloadRepository {
  readonly #reference: InMemoryPayloadReferenceRepository;
  readonly #cleanup: InMemoryPayloadCleanupRepository;
  readonly #namespace: InMemoryPayloadNamespaceRepository;

  constructor(
    reference: InMemoryPayloadReferenceRepository,
    cleanup: InMemoryPayloadCleanupRepository,
    namespace: InMemoryPayloadNamespaceRepository,
  ) {
    this.#reference = reference;
    this.#cleanup = cleanup;
    this.#namespace = namespace;
  }

  createPayloadReference(input: CreatePayloadReferenceInput): Promise<void> {
    return this.#reference.createPayloadReference(input);
  }

  getPayloadReference(id: string): Promise<PayloadReference | undefined> {
    return this.#reference.getPayloadReference(id);
  }

  getPayloadReferenceByObjectKey(
    objectKey: string,
  ): Promise<PayloadReference | undefined> {
    return this.#reference.getPayloadReferenceByObjectKey(objectKey);
  }

  listPayloadReferences(limit: number): Promise<readonly PayloadReference[]> {
    return this.#reference.listPayloadReferences(limit);
  }

  listPayloadReferencesPage(
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>> {
    return this.#reference.listPayloadReferencesPage(limit, cursor);
  }

  listExpiredPayloadReferences(
    now: IsoTimestamp,
    limit: number,
  ): Promise<readonly PayloadReference[]> {
    return this.#reference.listExpiredPayloadReferences(now, limit);
  }

  listExpiredPayloadReferencesPage(
    now: IsoTimestamp,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>> {
    return this.#reference.listExpiredPayloadReferencesPage(now, limit, cursor);
  }

  deletePayloadReference(input: DeletePayloadReferenceInput): Promise<void> {
    return this.#reference.deletePayloadReference(input);
  }

  createPayloadUploadIntent(
    input: CreatePayloadUploadIntentInput,
  ): Promise<PayloadUploadIntent> {
    return this.#reference.createPayloadUploadIntent(input);
  }

  getPayloadUploadIntent(id: string): Promise<PayloadUploadIntent | undefined> {
    return this.#reference.getPayloadUploadIntent(id);
  }

  getPayloadUploadIntentByObjectKey(
    objectKey: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return this.#reference.getPayloadUploadIntentByObjectKey(objectKey);
  }

  listPayloadUploadIntents(
    olderThan: IsoTimestamp,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadUploadIntent>> {
    return this.#reference.listPayloadUploadIntents(olderThan, limit, cursor);
  }

  markPayloadUploadIntentOrphaned(
    id: string,
    uploadGeneration: string,
    timestamp: IsoTimestamp,
    errorCode: string,
  ): Promise<void> {
    return this.#reference.markPayloadUploadIntentOrphaned(
      id,
      uploadGeneration,
      timestamp,
      errorCode,
    );
  }

  completePayloadUploadIntent(
    id: string,
    uploadGeneration: string,
  ): Promise<void> {
    return this.#reference.completePayloadUploadIntent(id, uploadGeneration);
  }

  claimPayloadCleanup(
    input: ClaimPayloadCleanupInput,
  ): Promise<ClaimPayloadCleanupResult> {
    return this.#cleanup.claimPayloadCleanup(input);
  }

  beginPayloadCleanupDeletion(
    input: BeginPayloadCleanupDeletionInput,
  ): Promise<BeginPayloadCleanupDeletionResult> {
    return this.#cleanup.beginPayloadCleanupDeletion(input);
  }

  finalizePayloadCleanupDeletion(
    input: FinalizePayloadCleanupDeletionInput,
  ): Promise<boolean> {
    return this.#cleanup.finalizePayloadCleanupDeletion(input);
  }

  releasePayloadCleanupClaim(
    input: ReleasePayloadCleanupClaimInput,
  ): Promise<boolean> {
    return this.#cleanup.releasePayloadCleanupClaim(input);
  }

  getPayloadCleanupClaim(
    objectKey: string,
  ): Promise<PayloadCleanupClaim | undefined> {
    return this.#cleanup.getPayloadCleanupClaim(objectKey);
  }

  listExpiredPayloadCleanupClaims(
    now: IsoTimestamp,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadCleanupClaim>> {
    return this.#cleanup.listExpiredPayloadCleanupClaims(now, limit, cursor);
  }

  getPayloadStorageNamespace(): Promise<
    PayloadStorageNamespaceState | undefined
  > {
    return this.#namespace.getPayloadStorageNamespace();
  }

  initializePayloadStorageNamespace(
    namespace: string,
    storeId: string,
    timestamp: IsoTimestamp,
  ): Promise<PayloadStorageNamespaceState> {
    return this.#namespace.initializePayloadStorageNamespace(
      namespace,
      storeId,
      timestamp,
    );
  }

  markPayloadStorageNamespaceReady(
    namespace: string,
    storeId: string,
    timestamp: IsoTimestamp,
  ): Promise<PayloadStorageNamespaceState> {
    return this.#namespace.markPayloadStorageNamespaceReady(
      namespace,
      storeId,
      timestamp,
    );
  }

  hasPayloadDataState(): Promise<boolean> {
    return this.#namespace.hasPayloadDataState();
  }

  hasPayloadPersistenceState(): Promise<boolean> {
    return this.#namespace.hasPayloadPersistenceState();
  }

  listPayloadCleanupTasks(
    limit: number,
    endpointId?: string,
    cursor?: string,
  ): Promise<readonly PayloadCleanupTask[]> {
    return this.#cleanup.listPayloadCleanupTasks(limit, endpointId, cursor);
  }

  markPayloadCleanupFailed(
    id: string,
    timestamp: IsoTimestamp,
    errorCode: string,
  ): Promise<void> {
    return this.#cleanup.markPayloadCleanupFailed(id, timestamp, errorCode);
  }

  completePayloadCleanup(id: string): Promise<void> {
    return this.#cleanup.completePayloadCleanup(id);
  }
}
