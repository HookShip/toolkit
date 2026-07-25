// SPDX-License-Identifier: Apache-2.0

import type { CanonicalMetadataRecord } from "@webhook-portal/adapter-sdk";
import { InMemoryContractReleaseRepository } from "./memory/memory-contract-release-repository.js";
import { InMemoryEndpointRepository } from "./memory/memory-endpoint-repository.js";
import { InMemoryPayloadCleanupRepository } from "./memory/memory-payload-cleanup-repository.js";
import { InMemoryPayloadNamespaceRepository } from "./memory/memory-payload-namespace-repository.js";
import { InMemoryPayloadReferenceRepository } from "./memory/memory-payload-reference-repository.js";
import { InMemoryPayloadRepository } from "./memory/memory-payload-repository.js";
import {
  InMemoryRepositoryState,
  type InMemoryReferenceRepositoryOptions,
} from "./memory/memory-repository-state.js";
import { InMemorySecretRepository } from "./memory/memory-secret-repository.js";
import { InMemoryTestCommandRepository } from "./memory/memory-test-command-repository.js";
import { InMemoryTimelineAuditRepository } from "./memory/memory-timeline-audit-repository.js";
import type {
  ReferenceRepository,
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
  CreateSecretVersionInput,
  CreateTestCommandInput,
  DeletePayloadReferenceInput,
  EndpointDeletionResult,
  EndpointRecord,
  FinalizePayloadCleanupDeletionInput,
  MetadataIngestSummary,
  OutboxRecord,
  PayloadCleanupClaim,
  PayloadCleanupTask,
  PayloadPage,
  PayloadReference,
  PayloadStorageNamespaceState,
  PayloadUploadIntent,
  PublishCommandRecord,
  PublishReleaseInput,
  PublishStatus,
  ReferenceRepositoryTransaction,
  ReleaseMetadataPage,
  ReleasePayloadCleanupClaimInput,
  ReleaseRecord,
  RepositoryReadiness,
  RotateSecretInput,
  SecretVersionRecord,
  SetSubscriptionInput,
  SubscriptionRecord,
  TestCommandRecord,
  TestCommandResult,
  TimelineEvidenceLockInput,
  TimelineFilters,
  TimelinePage,
  UpdateEndpointInput,
} from "./types.js";

export type { InMemoryReferenceRepositoryOptions } from "./memory/memory-repository-state.js";

export class InMemoryReferenceRepository implements ReferenceRepository {
  readonly #ctx: InMemoryRepositoryState;
  readonly #contractRelease: InMemoryContractReleaseRepository;
  readonly #endpoint: InMemoryEndpointRepository;
  readonly #secret: InMemorySecretRepository;
  readonly #testCommand: InMemoryTestCommandRepository;
  readonly #timelineAudit: InMemoryTimelineAuditRepository;
  readonly #payload: InMemoryPayloadRepository;

  constructor(options: InMemoryReferenceRepositoryOptions = {}) {
    this.#ctx = new InMemoryRepositoryState(options);
    this.#ctx.attach(this);
    this.#contractRelease = new InMemoryContractReleaseRepository(this.#ctx);
    this.#endpoint = new InMemoryEndpointRepository(this.#ctx);
    this.#secret = new InMemorySecretRepository(this.#ctx);
    this.#testCommand = new InMemoryTestCommandRepository(this.#ctx);
    this.#timelineAudit = new InMemoryTimelineAuditRepository(this.#ctx);
    this.#payload = new InMemoryPayloadRepository(
      new InMemoryPayloadReferenceRepository(this.#ctx),
      new InMemoryPayloadCleanupRepository(this.#ctx),
      new InMemoryPayloadNamespaceRepository(this.#ctx),
    );
  }

  async transaction<T>(
    callback: (transaction: ReferenceRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#ctx.transaction(this, callback);
  }

  async readiness(): Promise<RepositoryReadiness> {
    return this.#ctx.readiness();
  }

  async ping(): Promise<void> {
    return this.#ctx.ping();
  }

  async close(): Promise<void> {
    return this.#ctx.close();
  }

  get closed(): boolean {
    return this.#ctx.closed;
  }

  async getPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    return this.#contractRelease.getPublishStatus(idempotencyKey);
  }

  async recoverPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    return this.#contractRelease.recoverPublishStatus(idempotencyKey);
  }

  async createContractImport(record: ContractImportRecord): Promise<void> {
    return this.#contractRelease.createContractImport(record);
  }

  async getContractImport(
    id: string,
  ): Promise<ContractImportRecord | undefined> {
    return this.#contractRelease.getContractImport(id);
  }

  async lockReleaseState(): Promise<ReleaseRecord | undefined> {
    return this.#contractRelease.lockReleaseState();
  }

  async publishRelease(input: PublishReleaseInput): Promise<ReleaseRecord> {
    return this.#contractRelease.publishRelease(input);
  }

  async getActiveRelease(): Promise<ReleaseRecord | undefined> {
    return this.#contractRelease.getActiveRelease();
  }

  async getRelease(id: string): Promise<ReleaseRecord | undefined> {
    return this.#contractRelease.getRelease(id);
  }

  async listReleases(): Promise<readonly ReleaseRecord[]> {
    return this.#contractRelease.listReleases();
  }

  async listReleaseMetadataPage(
    limit: number,
    beforeSequence?: number,
  ): Promise<ReleaseMetadataPage> {
    return this.#contractRelease.listReleaseMetadataPage(limit, beforeSequence);
  }

  async createPublishCommand(record: PublishCommandRecord): Promise<void> {
    return this.#contractRelease.createPublishCommand(record);
  }

  async getPublishCommand(
    idempotencyKey: string,
  ): Promise<PublishCommandRecord | undefined> {
    return this.#contractRelease.getPublishCommand(idempotencyKey);
  }

  async completePublishCommand(
    id: string,
    releaseId: string,
    predecessorReleaseId: string | undefined,
    timestamp: string,
  ): Promise<PublishCommandRecord> {
    return this.#contractRelease.completePublishCommand(
      id,
      releaseId,
      predecessorReleaseId,
      timestamp,
    );
  }

  async createEndpoint(input: CreateEndpointInput): Promise<EndpointRecord> {
    return this.#endpoint.createEndpoint(input);
  }

  async getEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return this.#endpoint.getEndpoint(id);
  }

  async lockEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return this.#endpoint.lockEndpoint(id);
  }

  async listEndpoints(): Promise<readonly EndpointRecord[]> {
    return this.#endpoint.listEndpoints();
  }

  async updateEndpoint(
    id: string,
    input: UpdateEndpointInput,
  ): Promise<EndpointRecord | undefined> {
    return this.#endpoint.updateEndpoint(id, input);
  }

  async deleteEndpointData(
    id: string,
    timestamp: string,
  ): Promise<EndpointDeletionResult | undefined> {
    return this.#endpoint.deleteEndpointData(id, timestamp);
  }

  async setSubscription(
    input: SetSubscriptionInput,
  ): Promise<SubscriptionRecord> {
    return this.#endpoint.setSubscription(input);
  }

  async getSubscription(
    endpointId: string,
  ): Promise<SubscriptionRecord | undefined> {
    return this.#endpoint.getSubscription(endpointId);
  }

  async createSecretVersion(
    input: CreateSecretVersionInput,
  ): Promise<SecretVersionRecord> {
    return this.#secret.createSecretVersion(input);
  }

  async rotateSecret(input: RotateSecretInput): Promise<SecretVersionRecord> {
    return this.#secret.rotateSecret(input);
  }

  async revokeSecret(
    endpointId: string,
    secretId: string,
    timestamp: string,
  ): Promise<SecretVersionRecord | undefined> {
    return this.#secret.revokeSecret(endpointId, secretId, timestamp);
  }

  async getSecretVersion(
    endpointId: string,
    secretId: string,
  ): Promise<SecretVersionRecord | undefined> {
    return this.#secret.getSecretVersion(endpointId, secretId);
  }

  async listSecretVersions(
    endpointId: string,
  ): Promise<readonly SecretVersionRecord[]> {
    return this.#secret.listSecretVersions(endpointId);
  }

  async beginTestCommand(
    input: CreateTestCommandInput,
  ): Promise<BeginTestCommandResult> {
    return this.#testCommand.beginTestCommand(input);
  }

  async getTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return this.#testCommand.getTestCommand(id);
  }

  async getTestCommandByIdempotency(
    endpointId: string,
    idempotencyKey: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#testCommand.getTestCommandByIdempotency(
      endpointId,
      idempotencyKey,
    );
  }

  async lockTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return this.#testCommand.lockTestCommand(id);
  }

  async markTestCommandDispatched(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#testCommand.markTestCommandDispatched(id, timestamp);
  }

  async stageTestCommandResult(
    id: string,
    timestamp: string,
    result: TestCommandResult,
  ): Promise<TestCommandRecord | undefined> {
    return this.#testCommand.stageTestCommandResult(id, timestamp, result);
  }

  async completeTestCommand(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#testCommand.completeTestCommand(id, timestamp);
  }

  async acquireTimelineEvidenceLocks(
    input: TimelineEvidenceLockInput,
  ): Promise<void> {
    return this.#timelineAudit.acquireTimelineEvidenceLocks(input);
  }

  async ingestMetadata(
    records: readonly CanonicalMetadataRecord[],
    ingestedAt: string,
  ): Promise<MetadataIngestSummary> {
    return this.#timelineAudit.ingestMetadata(records, ingestedAt);
  }

  async listTimeline(filters: TimelineFilters): Promise<TimelinePage> {
    return this.#timelineAudit.listTimeline(filters);
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    return this.#timelineAudit.appendAudit(record);
  }

  async listAudit(limit: number): Promise<readonly AuditRecord[]> {
    return this.#timelineAudit.listAudit(limit);
  }

  async appendOutbox(record: OutboxRecord): Promise<void> {
    return this.#timelineAudit.appendOutbox(record);
  }

  async listOutbox(limit: number): Promise<readonly OutboxRecord[]> {
    return this.#timelineAudit.listOutbox(limit);
  }

  async createPayloadReference(
    input: CreatePayloadReferenceInput,
  ): Promise<void> {
    return this.#payload.createPayloadReference(input);
  }

  async getPayloadReference(id: string): Promise<PayloadReference | undefined> {
    return this.#payload.getPayloadReference(id);
  }

  async getPayloadReferenceByObjectKey(
    objectKey: string,
  ): Promise<PayloadReference | undefined> {
    return this.#payload.getPayloadReferenceByObjectKey(objectKey);
  }

  async listPayloadReferences(
    limit: number,
  ): Promise<readonly PayloadReference[]> {
    return this.#payload.listPayloadReferences(limit);
  }

  async listPayloadReferencesPage(
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>> {
    return this.#payload.listPayloadReferencesPage(limit, cursor);
  }

  async listExpiredPayloadReferences(
    now: string,
    limit: number,
  ): Promise<readonly PayloadReference[]> {
    return this.#payload.listExpiredPayloadReferences(now, limit);
  }

  async listExpiredPayloadReferencesPage(
    now: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>> {
    return this.#payload.listExpiredPayloadReferencesPage(now, limit, cursor);
  }

  async deletePayloadReference(
    input: DeletePayloadReferenceInput,
  ): Promise<void> {
    return this.#payload.deletePayloadReference(input);
  }

  async createPayloadUploadIntent(
    input: CreatePayloadUploadIntentInput,
  ): Promise<PayloadUploadIntent> {
    return this.#payload.createPayloadUploadIntent(input);
  }

  async getPayloadUploadIntent(
    id: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return this.#payload.getPayloadUploadIntent(id);
  }

  async getPayloadUploadIntentByObjectKey(
    objectKey: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return this.#payload.getPayloadUploadIntentByObjectKey(objectKey);
  }

  async listPayloadUploadIntents(
    olderThan: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadUploadIntent>> {
    return this.#payload.listPayloadUploadIntents(olderThan, limit, cursor);
  }

  async markPayloadUploadIntentOrphaned(
    id: string,
    uploadGeneration: string,
    timestamp: string,
    errorCode: string,
  ): Promise<void> {
    return this.#payload.markPayloadUploadIntentOrphaned(
      id,
      uploadGeneration,
      timestamp,
      errorCode,
    );
  }

  async completePayloadUploadIntent(
    id: string,
    uploadGeneration: string,
  ): Promise<void> {
    return this.#payload.completePayloadUploadIntent(id, uploadGeneration);
  }

  async claimPayloadCleanup(
    input: ClaimPayloadCleanupInput,
  ): Promise<ClaimPayloadCleanupResult> {
    return this.#payload.claimPayloadCleanup(input);
  }

  async beginPayloadCleanupDeletion(
    input: BeginPayloadCleanupDeletionInput,
  ): Promise<BeginPayloadCleanupDeletionResult> {
    return this.#payload.beginPayloadCleanupDeletion(input);
  }

  async finalizePayloadCleanupDeletion(
    input: FinalizePayloadCleanupDeletionInput,
  ): Promise<boolean> {
    return this.#payload.finalizePayloadCleanupDeletion(input);
  }

  async releasePayloadCleanupClaim(
    input: ReleasePayloadCleanupClaimInput,
  ): Promise<boolean> {
    return this.#payload.releasePayloadCleanupClaim(input);
  }

  async getPayloadCleanupClaim(
    objectKey: string,
  ): Promise<PayloadCleanupClaim | undefined> {
    return this.#payload.getPayloadCleanupClaim(objectKey);
  }

  async listExpiredPayloadCleanupClaims(
    now: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadCleanupClaim>> {
    return this.#payload.listExpiredPayloadCleanupClaims(now, limit, cursor);
  }

  async listPayloadCleanupTasks(
    limit: number,
    endpointId?: string,
    cursor?: string,
  ): Promise<readonly PayloadCleanupTask[]> {
    return this.#payload.listPayloadCleanupTasks(limit, endpointId, cursor);
  }

  async markPayloadCleanupFailed(
    id: string,
    timestamp: string,
    errorCode: string,
  ): Promise<void> {
    return this.#payload.markPayloadCleanupFailed(id, timestamp, errorCode);
  }

  async completePayloadCleanup(id: string): Promise<void> {
    return this.#payload.completePayloadCleanup(id);
  }

  async getPayloadStorageNamespace(): Promise<
    PayloadStorageNamespaceState | undefined
  > {
    return this.#payload.getPayloadStorageNamespace();
  }

  async initializePayloadStorageNamespace(
    namespace: string,
    storeId: string,
    timestamp: string,
  ): Promise<PayloadStorageNamespaceState> {
    return this.#payload.initializePayloadStorageNamespace(
      namespace,
      storeId,
      timestamp,
    );
  }

  async markPayloadStorageNamespaceReady(
    namespace: string,
    storeId: string,
    timestamp: string,
  ): Promise<PayloadStorageNamespaceState> {
    return this.#payload.markPayloadStorageNamespaceReady(
      namespace,
      storeId,
      timestamp,
    );
  }

  async hasPayloadDataState(): Promise<boolean> {
    return this.#payload.hasPayloadDataState();
  }

  async hasPayloadPersistenceState(): Promise<boolean> {
    return this.#payload.hasPayloadPersistenceState();
  }
}
