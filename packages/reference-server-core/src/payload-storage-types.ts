// SPDX-License-Identifier: Apache-2.0

export const PAYLOAD_NAMESPACE_MARKER_KEY = ".webhook-portal/payload-namespace";
export const PAYLOAD_NAMESPACE_ID_PATTERN = /^[0-9a-f]{22}$/u;
export const PAYLOAD_STORE_ID_PATTERN = /^[0-9a-f]{22}$/u;

export function validatePayloadStorageIdentity(
  namespace: string,
  storeId: string,
): void {
  if (!PAYLOAD_NAMESPACE_ID_PATTERN.test(namespace)) {
    throw new RangeError(
      "Payload namespace IDs must be 22 lowercase hexadecimal characters.",
    );
  }
  if (!PAYLOAD_STORE_ID_PATTERN.test(storeId)) {
    throw new RangeError(
      "Payload store IDs must be 22 lowercase hexadecimal characters.",
    );
  }
  if (namespace === storeId) {
    throw new RangeError("Payload namespace and store IDs must be distinct.");
  }
}

export function payloadBucketName(
  namespaceId: string,
  storeId: string,
): string {
  validatePayloadStorageIdentity(namespaceId, storeId);
  return `webhook-payloads-${namespaceId}-${storeId}`;
}

export type PayloadBucketVersioning = "enabled" | "suspended" | "unversioned";

export interface PayloadStorageIdentityInspection {
  readonly bucketExists: boolean;
  readonly empty: boolean;
  readonly versioning: PayloadBucketVersioning;
  readonly namespace?: string;
  readonly storeId?: string;
}

export class PayloadStorageIdentityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PayloadStorageIdentityError";
    this.code = code;
  }
}

export interface PutPayloadInput {
  readonly objectKey: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PayloadLifecyclePolicy {
  readonly prefix: string;
  readonly expireAfterDays: number;
  readonly abortIncompleteMultipartAfterDays?: number;
}

export interface PayloadStorageCapabilities {
  readonly capture: boolean;
  readonly cleanup: boolean;
}

export interface PayloadObject {
  readonly objectKey: string;
  readonly createdAt?: string;
}

export interface PayloadObjectPage {
  readonly items: readonly PayloadObject[];
  readonly nextCursor?: string;
}

export interface PayloadCleanupStorage {
  readonly capabilities: PayloadStorageCapabilities;
  ping(): Promise<void>;
  delete(objectKey: string): Promise<void>;
  exists(objectKey: string): Promise<boolean>;
  listObjects(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadObjectPage>;
  listObjectKeys(prefix: string, limit: number): Promise<readonly string[]>;
  configureLifecycle(policy: PayloadLifecyclePolicy): Promise<void>;
  inspectIdentity(): Promise<PayloadStorageIdentityInspection>;
  initializeIdentity(namespace: string, storeId: string): Promise<void>;
  close(): Promise<void>;
}

export interface PayloadCaptureStorage {
  readonly capabilities: PayloadStorageCapabilities;
  put(input: PutPayloadInput): Promise<void>;
}

export interface PayloadStorage
  extends PayloadCaptureStorage, PayloadCleanupStorage {}

export interface PayloadOperationFailure {
  readonly operation:
    | "complete_cleanup"
    | "complete_upload_intent"
    | "begin_cleanup_deletion"
    | "claim_cleanup"
    | "delete_object"
    | "delete_reference"
    | "finalize_cleanup_deletion"
    | "inspect_object"
    | "list_cleanup_tasks"
    | "list_cleanup_claims"
    | "list_objects"
    | "list_references"
    | "list_upload_intents"
    | "mark_cleanup_failed"
    | "mark_upload_intent"
    | "release_cleanup_claim";
  readonly referenceId?: string;
  readonly cleanupTaskId?: string;
  readonly cleanupClaimId?: string;
  readonly cleanupClaimGeneration?: number;
  readonly uploadIntentId?: string;
  readonly objectKey?: string;
  readonly errorCode: string;
}

export interface PayloadSweepReport {
  readonly scanned: number;
  readonly deleted: number;
  readonly failures: readonly PayloadOperationFailure[];
  readonly nextCursor?: string;
}

export interface PayloadPageStreamState<TCursor = string> {
  readonly exhausted: boolean;
  readonly cursor?: TCursor;
}

export interface PayloadReconciliationCursor {
  readonly cleanupClaims: PayloadPageStreamState;
  readonly objects: PayloadPageStreamState;
  readonly references: PayloadPageStreamState;
  readonly uploadIntents: PayloadPageStreamState;
}

export interface PayloadReconciliationReport {
  readonly inspectedCleanupClaims: number;
  readonly inspectedObjects: number;
  readonly inspectedReferences: number;
  readonly inspectedUploadIntents: number;
  readonly deletedOrphanObjects: number;
  readonly clearedDanglingReferences: number;
  readonly clearedUploadIntents: number;
  readonly deferredObjects: number;
  readonly failures: readonly PayloadOperationFailure[];
  readonly cycleCompleted: boolean;
  readonly nextCursor?: PayloadReconciliationCursor;
}

export function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 128);
  }
  return error instanceof Error
    ? error.name.slice(0, 128)
    : "unknown_storage_error";
}

export function validateLifecyclePolicy(policy: PayloadLifecyclePolicy): void {
  if (
    policy.prefix.length === 0 ||
    !Number.isSafeInteger(policy.expireAfterDays) ||
    policy.expireAfterDays < 1
  ) {
    throw new RangeError("Payload lifecycle policy is invalid.");
  }
  if (
    policy.abortIncompleteMultipartAfterDays !== undefined &&
    (!Number.isSafeInteger(policy.abortIncompleteMultipartAfterDays) ||
      policy.abortIncompleteMultipartAfterDays < 1)
  ) {
    throw new RangeError(
      "Payload multipart-abort lifecycle policy is invalid.",
    );
  }
}
