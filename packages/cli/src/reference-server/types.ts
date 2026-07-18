// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalContract,
  CanonicalContractExport,
  CompatibilityResult,
  ContractDiagnostic,
  ContractImportStatus,
  JsonValue,
} from "@webhook-portal/contract-core";
import type {
  CanonicalMetadataRecord,
  DeliveryAttemptReduction,
  MetadataIdentity,
} from "@webhook-portal/adapter-sdk";

export type IsoTimestamp = string;

export interface ContractImportRecord {
  readonly id: string;
  readonly createdAt: IsoTimestamp;
  readonly source: string;
  readonly sourceMediaType: "application/json" | "application/yaml";
  readonly sourceUri?: string;
  readonly sourceChecksum?: string;
  readonly status: ContractImportStatus;
  readonly diagnostics: readonly ContractDiagnostic[];
  readonly contract?: CanonicalContract;
  readonly canonicalExport?: CanonicalContractExport;
}

export interface ReleaseChangelog {
  readonly summary: string;
  readonly status: CompatibilityResult["status"] | "initial";
  readonly changes: readonly CompatibilityResult["changes"][number][];
}

export interface ReleaseRecord {
  readonly id: string;
  readonly importId: string;
  readonly sequence: number;
  readonly createdAt: IsoTimestamp;
  readonly active: boolean;
  readonly checksum: string;
  readonly contract: CanonicalContract;
  readonly canonicalExport: CanonicalContractExport;
  readonly compatibility?: CompatibilityResult;
  readonly changelog: ReleaseChangelog;
  readonly overrideReason?: string;
}

export interface ReleaseEventPreview {
  readonly id: string;
  readonly externalName: string;
  readonly externalNameTruncated: boolean;
  readonly versionCount: number;
}

export interface ReleaseEventSummary {
  readonly eventTypeCount: number;
  readonly eventVersionCount: number;
  readonly preview: readonly ReleaseEventPreview[];
  readonly truncated: boolean;
}

export interface ReleaseMetadata {
  readonly id: string;
  readonly importId: string;
  readonly sequence: number;
  readonly checksum: string;
  readonly status: "active" | "superseded";
  readonly createdAt: IsoTimestamp;
  readonly compatibilityStatus: ReleaseChangelog["status"];
  readonly changeCount: number;
  readonly eventSummary: ReleaseEventSummary;
}

export interface ReleaseMetadataPage {
  readonly items: readonly ReleaseMetadata[];
  readonly nextBeforeSequence?: number;
}

export type EndpointState = "active" | "deleted" | "paused";

export interface LiveEndpointRecord {
  readonly id: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly url: string;
  readonly description?: string;
  readonly allowLocalNetwork: boolean;
  readonly state: Exclude<EndpointState, "deleted">;
}

export interface EndpointTombstone {
  readonly id: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly deletedAt: IsoTimestamp;
  readonly state: "deleted";
  readonly tombstoneVersion: 1;
}

export type EndpointRecord = LiveEndpointRecord | EndpointTombstone;

export type SubscriptionState = "active" | "paused";

export interface SubscriptionRecord {
  readonly id: string;
  readonly endpointId: string;
  readonly eventTypes: readonly string[];
  readonly state: SubscriptionState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface EncryptedValue {
  readonly algorithm: "aes-256-gcm";
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export type StoredSecretState =
  "active" | "overlapping" | "revoked" | "expired";

export interface SecretVersionRecord {
  readonly id: string;
  readonly endpointId: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly state: StoredSecretState;
  readonly encryptedValue: EncryptedValue;
  readonly notBefore?: number;
  readonly expiresAt?: number;
}

export interface SecretVersionMetadata {
  readonly id: string;
  readonly endpointId: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly state: StoredSecretState;
  readonly notBefore?: number;
  readonly expiresAt?: number;
}

export type TestCommandState =
  | "requested"
  | "dispatched"
  | "acknowledged"
  | "failed"
  | "unknown"
  | "cancelled"
  | "expired"
  | "rejected_before_dispatch";

export interface TestCommandResult {
  readonly state: TestCommandState;
  readonly delivered: boolean;
  readonly statusCode?: number;
  readonly messageId?: string;
  readonly errorCategory?: string;
  readonly detail?: string;
}

export interface TestPayloadContext {
  readonly contentType: "application/json";
  readonly size: number;
  readonly ttlSeconds: number;
}

export interface TestRequestContext {
  readonly endpointUrl: string;
  readonly allowLocalNetwork: boolean;
  readonly releaseId: string;
  readonly schemaChecksum: string;
  readonly eventVersion: string;
  readonly bodySha256: string;
  readonly messageId: string;
  readonly signingSecretId?: string;
  readonly payload?: TestPayloadContext;
}

export type TestEvidenceState = "complete" | "pending";

export interface TestCommandRecord {
  readonly id: string;
  readonly endpointId: string;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly state: TestCommandState;
  readonly evidenceState: TestEvidenceState;
  readonly context: TestRequestContext;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly dispatchedAt?: IsoTimestamp;
  readonly resultObservedAt?: IsoTimestamp;
  readonly pendingResult?: TestCommandResult;
  readonly result?: TestCommandResult;
}

export type BeginTestCommandResult =
  | { readonly status: "created"; readonly command: TestCommandRecord }
  | { readonly status: "existing"; readonly command: TestCommandRecord }
  | { readonly status: "conflict"; readonly command: TestCommandRecord };

export interface MetadataObservation {
  readonly record: CanonicalMetadataRecord;
  readonly ingestedAt: IsoTimestamp;
  readonly late: boolean;
}

export interface TimelineEntry {
  readonly deliveryId: string;
  readonly current: CanonicalMetadataRecord;
  readonly reduction: DeliveryAttemptReduction;
  readonly firstIngestedAt: IsoTimestamp;
  readonly lastIngestedAt: IsoTimestamp;
  readonly observationCount: number;
  readonly lateObservationCount: number;
  readonly payloadRetained: boolean;
}

export interface TimelineFilters {
  readonly deliveryId?: string;
  readonly endpointId?: string;
  readonly eventId?: string;
  readonly eventType?: string;
  readonly status?: CanonicalMetadataRecord["status"];
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface TimelinePage {
  readonly items: readonly TimelineEntry[];
  readonly nextCursor?: string;
}

export interface MetadataIngestSummary {
  readonly accepted: number;
  readonly duplicates: number;
  readonly late: number;
}

export interface TimelineEvidenceLockInput {
  readonly commandIds?: readonly string[];
  readonly endpointIds?: readonly string[];
  readonly records?: readonly CanonicalMetadataRecord[];
}

export interface AuditRecord {
  readonly id: string;
  readonly createdAt: IsoTimestamp;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly result: "denied" | "failure" | "success" | "unknown";
  readonly actorId: string;
  readonly correlationId: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface OutboxRecord {
  readonly id: string;
  readonly createdAt: IsoTimestamp;
  readonly topic: string;
  readonly aggregateType: string;
  readonly aggregateId?: string;
  readonly correlationId: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
}

export interface PayloadReference {
  readonly id: string;
  readonly objectKey: string;
  readonly uploadAttemptId: string;
  readonly uploadGeneration: string;
  readonly contentType: string;
  readonly size: number;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly endpointId?: string;
  readonly deliveryId?: string;
}

export type PayloadUploadIntentState = "orphaned" | "pending";

export interface PayloadUploadIntent extends PayloadReference {
  readonly uploadAttemptId: string;
  readonly uploadGeneration: string;
  readonly state: PayloadUploadIntentState;
  readonly updatedAt: IsoTimestamp;
  readonly attempts: number;
  readonly lastErrorCode?: string;
}

export type PayloadCleanupClaimState = "claimed" | "deleted" | "deleting";
export type PayloadCleanupClaimReason = "legacy_orphan" | "stale_upload_intent";

export interface PayloadCleanupClaim {
  readonly objectKey: string;
  readonly claimId: string;
  readonly generation: number;
  readonly state: PayloadCleanupClaimState;
  readonly reason: PayloadCleanupClaimReason;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly leaseExpiresAt: IsoTimestamp;
  readonly uploadIntentId?: string;
  readonly uploadGeneration?: string;
  readonly lastErrorCode?: string;
}

export interface ClaimPayloadCleanupInput {
  readonly objectKey: string;
  readonly claimId: string;
  readonly reason: PayloadCleanupClaimReason;
  readonly timestamp: IsoTimestamp;
  readonly leaseExpiresAt: IsoTimestamp;
  readonly uploadIntentId?: string;
  readonly uploadGeneration?: string;
}

export type ClaimPayloadCleanupResult =
  | { readonly status: "claimed"; readonly claim: PayloadCleanupClaim }
  | { readonly status: "busy"; readonly claim: PayloadCleanupClaim }
  | { readonly status: "deleted"; readonly claim: PayloadCleanupClaim }
  | { readonly status: "intent_missing" }
  | { readonly status: "intent_present" }
  | { readonly status: "referenced" };

export interface BeginPayloadCleanupDeletionInput {
  readonly objectKey: string;
  readonly claimId: string;
  readonly generation: number;
  readonly timestamp: IsoTimestamp;
  readonly leaseExpiresAt: IsoTimestamp;
  readonly uploadIntentId?: string;
  readonly uploadGeneration?: string;
}

export type BeginPayloadCleanupDeletionResult =
  | { readonly status: "deleting"; readonly claim: PayloadCleanupClaim }
  | { readonly status: "deleted" | "lost" | "referenced" };

export interface FinalizePayloadCleanupDeletionInput {
  readonly objectKey: string;
  readonly claimId: string;
  readonly generation: number;
  readonly timestamp: IsoTimestamp;
  readonly uploadIntentId?: string;
  readonly uploadGeneration?: string;
}

export interface ReleasePayloadCleanupClaimInput extends FinalizePayloadCleanupDeletionInput {
  readonly errorCode: string;
}

export interface PayloadPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export type PayloadCleanupReason = "endpoint_deleted" | "expired" | "orphaned";

export interface PayloadCleanupTask {
  readonly id: string;
  readonly objectKey: string;
  readonly reason: PayloadCleanupReason;
  readonly state: "failed" | "pending";
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly attempts: number;
  readonly endpointId?: string;
  readonly lastErrorCode?: string;
}

export interface PayloadStorageNamespaceState {
  readonly namespace: string;
  readonly storeId?: string;
  readonly status: "binding" | "ready" | "upgrading";
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface RepositoryReadiness {
  readonly ready: boolean;
  readonly expectedSchemaVersion: string;
  readonly appliedSchemaVersions: readonly string[];
  readonly currentSchemaVersion?: string;
  readonly missingSchemaVersions: readonly string[];
  readonly unexpectedSchemaVersions: readonly string[];
  readonly checksumMismatches: readonly MigrationChecksumMismatch[];
}

export interface MigrationChecksumMismatch {
  readonly version: string;
  readonly expectedChecksum?: string;
  readonly actualChecksum?: string;
}

export type PublishCommandState = "completed" | "requested";

export interface PublishCommandRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly importId: string;
  readonly state: PublishCommandState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly predecessorReleaseId?: string;
  readonly releaseId?: string;
}

export type PublishStatus =
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
      readonly release: ReleaseRecord;
    }
  | {
      readonly status: "inconsistent";
      readonly idempotencyKey: string;
      readonly command: PublishCommandRecord;
      readonly reason: "release_not_found";
    };

export interface PublishReleaseInput {
  readonly id: string;
  readonly importRecord: ContractImportRecord;
  readonly compatibility?: CompatibilityResult;
  readonly changelog: ReleaseChangelog;
  readonly createdAt: IsoTimestamp;
  readonly overrideReason?: string;
}

export interface CreateEndpointInput {
  readonly id: string;
  readonly createdAt: IsoTimestamp;
  readonly url: string;
  readonly description?: string;
  readonly allowLocalNetwork: boolean;
}

export interface UpdateEndpointInput {
  readonly updatedAt: IsoTimestamp;
  readonly url?: string;
  readonly description?: string | null;
  readonly allowLocalNetwork?: boolean;
  readonly state?: EndpointState;
}

export interface SetSubscriptionInput {
  readonly id: string;
  readonly endpointId: string;
  readonly eventTypes: readonly string[];
  readonly state: SubscriptionState;
  readonly timestamp: IsoTimestamp;
}

export interface CreateSecretVersionInput {
  readonly id: string;
  readonly endpointId: string;
  readonly encryptedValue: EncryptedValue;
  readonly state: StoredSecretState;
  readonly timestamp: IsoTimestamp;
  readonly notBefore?: number;
  readonly expiresAt?: number;
}

export interface RotateSecretInput {
  readonly endpointId: string;
  readonly replacement: CreateSecretVersionInput;
  readonly overlapUntil: number;
  readonly timestamp: IsoTimestamp;
}

export interface CreateTestCommandInput {
  readonly id: string;
  readonly endpointId: string;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly context: TestRequestContext;
  readonly timestamp: IsoTimestamp;
}

export type CreatePayloadReferenceInput = PayloadReference;
export type DeletePayloadReferenceInput = Pick<
  PayloadReference,
  "id" | "objectKey" | "uploadAttemptId" | "uploadGeneration"
>;
export type CreatePayloadUploadIntentInput = Omit<
  PayloadUploadIntent,
  "attempts" | "lastErrorCode" | "state" | "updatedAt"
>;

export interface EndpointDeletionResult {
  readonly endpoint: EndpointTombstone;
  readonly cleanupTasks: readonly PayloadCleanupTask[];
  readonly newlyDeleted: boolean;
}

export interface ReferenceRepositoryTransaction {
  createContractImport(record: ContractImportRecord): Promise<void>;
  getContractImport(id: string): Promise<ContractImportRecord | undefined>;
  lockReleaseState(): Promise<ReleaseRecord | undefined>;
  publishRelease(input: PublishReleaseInput): Promise<ReleaseRecord>;
  getActiveRelease(): Promise<ReleaseRecord | undefined>;
  getRelease(id: string): Promise<ReleaseRecord | undefined>;
  listReleases(): Promise<readonly ReleaseRecord[]>;
  listReleaseMetadataPage(
    limit: number,
    beforeSequence?: number,
  ): Promise<ReleaseMetadataPage>;
  createPublishCommand(record: PublishCommandRecord): Promise<void>;
  getPublishCommand(
    idempotencyKey: string,
  ): Promise<PublishCommandRecord | undefined>;
  completePublishCommand(
    id: string,
    releaseId: string,
    predecessorReleaseId: string | undefined,
    timestamp: IsoTimestamp,
  ): Promise<PublishCommandRecord>;

  createEndpoint(input: CreateEndpointInput): Promise<EndpointRecord>;
  getEndpoint(id: string): Promise<EndpointRecord | undefined>;
  lockEndpoint(id: string): Promise<EndpointRecord | undefined>;
  listEndpoints(): Promise<readonly EndpointRecord[]>;
  updateEndpoint(
    id: string,
    input: UpdateEndpointInput,
  ): Promise<EndpointRecord | undefined>;
  deleteEndpointData(
    id: string,
    timestamp: IsoTimestamp,
  ): Promise<EndpointDeletionResult | undefined>;

  setSubscription(input: SetSubscriptionInput): Promise<SubscriptionRecord>;
  getSubscription(endpointId: string): Promise<SubscriptionRecord | undefined>;

  createSecretVersion(
    input: CreateSecretVersionInput,
  ): Promise<SecretVersionRecord>;
  rotateSecret(input: RotateSecretInput): Promise<SecretVersionRecord>;
  revokeSecret(
    endpointId: string,
    secretId: string,
    timestamp: IsoTimestamp,
  ): Promise<SecretVersionRecord | undefined>;
  getSecretVersion(
    endpointId: string,
    secretId: string,
  ): Promise<SecretVersionRecord | undefined>;
  listSecretVersions(
    endpointId: string,
  ): Promise<readonly SecretVersionRecord[]>;

  beginTestCommand(
    input: CreateTestCommandInput,
  ): Promise<BeginTestCommandResult>;
  getTestCommand(id: string): Promise<TestCommandRecord | undefined>;
  getTestCommandByIdempotency(
    endpointId: string,
    idempotencyKey: string,
  ): Promise<TestCommandRecord | undefined>;
  lockTestCommand(id: string): Promise<TestCommandRecord | undefined>;
  markTestCommandDispatched(
    id: string,
    timestamp: IsoTimestamp,
  ): Promise<TestCommandRecord | undefined>;
  stageTestCommandResult(
    id: string,
    timestamp: IsoTimestamp,
    result: TestCommandResult,
  ): Promise<TestCommandRecord | undefined>;
  completeTestCommand(
    id: string,
    timestamp: IsoTimestamp,
  ): Promise<TestCommandRecord | undefined>;

  acquireTimelineEvidenceLocks(input: TimelineEvidenceLockInput): Promise<void>;
  ingestMetadata(
    records: readonly CanonicalMetadataRecord[],
    ingestedAt: IsoTimestamp,
  ): Promise<MetadataIngestSummary>;
  listTimeline(filters: TimelineFilters): Promise<TimelinePage>;

  appendAudit(record: AuditRecord): Promise<void>;
  listAudit(limit: number): Promise<readonly AuditRecord[]>;
  appendOutbox(record: OutboxRecord): Promise<void>;
  listOutbox(limit: number): Promise<readonly OutboxRecord[]>;

  createPayloadReference(input: CreatePayloadReferenceInput): Promise<void>;
  getPayloadReference(id: string): Promise<PayloadReference | undefined>;
  getPayloadReferenceByObjectKey(
    objectKey: string,
  ): Promise<PayloadReference | undefined>;
  listPayloadReferences(limit: number): Promise<readonly PayloadReference[]>;
  listPayloadReferencesPage(
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>>;
  listExpiredPayloadReferences(
    now: IsoTimestamp,
    limit: number,
  ): Promise<readonly PayloadReference[]>;
  listExpiredPayloadReferencesPage(
    now: IsoTimestamp,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>>;
  deletePayloadReference(input: DeletePayloadReferenceInput): Promise<void>;
  createPayloadUploadIntent(
    input: CreatePayloadUploadIntentInput,
  ): Promise<PayloadUploadIntent>;
  getPayloadUploadIntent(id: string): Promise<PayloadUploadIntent | undefined>;
  getPayloadUploadIntentByObjectKey(
    objectKey: string,
  ): Promise<PayloadUploadIntent | undefined>;
  listPayloadUploadIntents(
    olderThan: IsoTimestamp,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadUploadIntent>>;
  markPayloadUploadIntentOrphaned(
    id: string,
    uploadGeneration: string,
    timestamp: IsoTimestamp,
    errorCode: string,
  ): Promise<void>;
  completePayloadUploadIntent(
    id: string,
    uploadGeneration: string,
  ): Promise<void>;
  claimPayloadCleanup(
    input: ClaimPayloadCleanupInput,
  ): Promise<ClaimPayloadCleanupResult>;
  beginPayloadCleanupDeletion(
    input: BeginPayloadCleanupDeletionInput,
  ): Promise<BeginPayloadCleanupDeletionResult>;
  finalizePayloadCleanupDeletion(
    input: FinalizePayloadCleanupDeletionInput,
  ): Promise<boolean>;
  releasePayloadCleanupClaim(
    input: ReleasePayloadCleanupClaimInput,
  ): Promise<boolean>;
  getPayloadCleanupClaim(
    objectKey: string,
  ): Promise<PayloadCleanupClaim | undefined>;
  listExpiredPayloadCleanupClaims(
    now: IsoTimestamp,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadCleanupClaim>>;
  getPayloadStorageNamespace(): Promise<
    PayloadStorageNamespaceState | undefined
  >;
  initializePayloadStorageNamespace(
    namespace: string,
    storeId: string,
    timestamp: IsoTimestamp,
  ): Promise<PayloadStorageNamespaceState>;
  markPayloadStorageNamespaceReady(
    namespace: string,
    storeId: string,
    timestamp: IsoTimestamp,
  ): Promise<PayloadStorageNamespaceState>;
  hasPayloadDataState(): Promise<boolean>;
  hasPayloadPersistenceState(): Promise<boolean>;
  listPayloadCleanupTasks(
    limit: number,
    endpointId?: string,
    cursor?: string,
  ): Promise<readonly PayloadCleanupTask[]>;
  markPayloadCleanupFailed(
    id: string,
    timestamp: IsoTimestamp,
    errorCode: string,
  ): Promise<void>;
  completePayloadCleanup(id: string): Promise<void>;
}

export interface ReferenceRepository extends ReferenceRepositoryTransaction {
  ping(): Promise<void>;
  readiness(): Promise<RepositoryReadiness>;
  close(): Promise<void>;
  getPublishStatus(idempotencyKey: string): Promise<PublishStatus>;
  recoverPublishStatus(idempotencyKey: string): Promise<PublishStatus>;
  transaction<T>(
    callback: (transaction: ReferenceRepositoryTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ReferenceServerConfig {
  readonly apiToken: string;
  readonly allowLocalNetwork: boolean;
  readonly contractBodyLimitBytes: number;
  readonly host: string;
  readonly ingestCredential: {
    readonly id: string;
    readonly secret: string;
  };
  readonly metadataIdentity: MetadataIdentity;
  readonly payloadStorageNamespaceId: string;
  readonly payloadStorageStoreId: string;
  readonly payloadRetention: {
    readonly enabled: boolean;
    readonly ttlSeconds: number;
  };
  readonly payloadMaintenance: {
    readonly batchSize: number;
    readonly gracePeriodMilliseconds: number;
    readonly intervalMilliseconds: number;
  };
  readonly port: number;
  readonly requestBodyLimitBytes: number;
  readonly sendTestBodyLimitBytes: number;
  readonly sendTestTimeoutMilliseconds: number;
  readonly tls?: {
    readonly certificate: Buffer;
    readonly privateKey: Buffer;
  };
}

export const DEFAULT_REFERENCE_SERVER_CONFIG: Readonly<
  Omit<ReferenceServerConfig, "apiToken" | "ingestCredential" | "tls">
> = Object.freeze({
  allowLocalNetwork: false,
  contractBodyLimitBytes: 4 * 1024 * 1024,
  host: "127.0.0.1",
  metadataIdentity: Object.freeze({
    adapterId: "generic-http",
    connectionId: "local",
    environment: "development",
    tenantId: "local",
  }),
  payloadStorageNamespaceId: "0000000000000000000001",
  payloadStorageStoreId: "0000000000000000000002",
  payloadRetention: Object.freeze({
    enabled: false,
    ttlSeconds: 24 * 60 * 60,
  }),
  payloadMaintenance: Object.freeze({
    batchSize: 100,
    gracePeriodMilliseconds: 5 * 60 * 1000,
    intervalMilliseconds: 60 * 1000,
  }),
  port: 3210,
  requestBodyLimitBytes: 1024 * 1024,
  sendTestBodyLimitBytes: 256 * 1024,
  sendTestTimeoutMilliseconds: 10_000,
});
