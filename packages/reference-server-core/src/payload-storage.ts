// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  Client as MinioClient,
  type ClientOptions,
  type LifecycleConfig,
} from "minio";

import type { ReferenceRepository } from "./types.js";
import { compareCodeUnits } from "./ordering.js";

export const PAYLOAD_NAMESPACE_MARKER_KEY = ".webhook-portal/payload-namespace";
export const PAYLOAD_NAMESPACE_ID_PATTERN = /^[0-9a-f]{22}$/u;
export const PAYLOAD_STORE_ID_PATTERN = /^[0-9a-f]{22}$/u;

function validatePayloadStorageIdentity(
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

function errorCode(error: unknown): string {
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

function validateLifecyclePolicy(policy: PayloadLifecyclePolicy): void {
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

export class DisabledPayloadStorage implements PayloadStorage {
  readonly capabilities = Object.freeze({ capture: false, cleanup: false });

  async ping(): Promise<void> {}

  async put(): Promise<void> {
    throw new Error("Payload retention is disabled.");
  }

  async delete(): Promise<void> {
    throw new Error(
      "Payload storage is unavailable while retention is disabled.",
    );
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async listObjects(): Promise<PayloadObjectPage> {
    return { items: [] };
  }

  async listObjectKeys(): Promise<readonly string[]> {
    return [];
  }

  async configureLifecycle(): Promise<void> {}

  async inspectIdentity(): Promise<PayloadStorageIdentityInspection> {
    return {
      bucketExists: false,
      empty: true,
      versioning: "unversioned",
    };
  }

  async initializeIdentity(): Promise<void> {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_UNAVAILABLE",
      "Payload object storage is unavailable.",
    );
  }

  async close(): Promise<void> {}
}

export class InMemoryPayloadStorage implements PayloadStorage {
  readonly capabilities = Object.freeze({ capture: true, cleanup: true });
  readonly #objects = new Map<string, PutPayloadInput>();
  #lifecyclePolicy: PayloadLifecyclePolicy | undefined;
  #bucketExists = true;
  #namespace: string | undefined;
  #storeId: string | undefined;
  #versioning: PayloadBucketVersioning = "unversioned";

  async ping(): Promise<void> {
    const inspection = await this.inspectIdentity();
    if (
      !inspection.bucketExists ||
      inspection.namespace === undefined ||
      inspection.storeId === undefined
    ) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_IDENTITY_UNAVAILABLE",
        "Payload storage identity is unavailable.",
      );
    }
    if (inspection.versioning !== "unversioned") {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_VERSIONING_UNSUPPORTED",
        "Versioned payload buckets are not supported.",
      );
    }
  }

  async put(input: PutPayloadInput): Promise<void> {
    this.#objects.set(input.objectKey, {
      ...input,
      bytes: Uint8Array.from(input.bytes),
    });
  }

  async delete(objectKey: string): Promise<void> {
    this.#objects.delete(objectKey);
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.#objects.has(objectKey);
  }

  async listObjectKeys(
    prefix: string,
    limit: number,
  ): Promise<readonly string[]> {
    return (await this.listObjects(prefix, limit)).items.map(
      (item) => item.objectKey,
    );
  }

  async listObjects(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadObjectPage> {
    const matches = [...this.#objects.values()]
      .filter(
        (value) =>
          value.objectKey.startsWith(prefix) &&
          (cursor === undefined ||
            compareCodeUnits(value.objectKey, cursor) > 0),
      )
      .sort((left, right) => compareCodeUnits(left.objectKey, right.objectKey));
    const items = matches.slice(0, limit).map((value) => ({
      objectKey: value.objectKey,
      createdAt: value.createdAt,
    }));
    return {
      items,
      ...(matches.length > limit && items.length > 0
        ? { nextCursor: items[items.length - 1]!.objectKey }
        : {}),
    };
  }

  async configureLifecycle(policy: PayloadLifecyclePolicy): Promise<void> {
    validateLifecyclePolicy(policy);
    this.#lifecyclePolicy = { ...policy };
  }

  async inspectIdentity(): Promise<PayloadStorageIdentityInspection> {
    return {
      bucketExists: this.#bucketExists,
      empty: !this.#bucketExists || this.#objects.size === 0,
      versioning: this.#versioning,
      ...(this.#namespace === undefined ? {} : { namespace: this.#namespace }),
      ...(this.#storeId === undefined ? {} : { storeId: this.#storeId }),
    };
  }

  async initializeIdentity(namespace: string, storeId: string): Promise<void> {
    validatePayloadStorageIdentity(namespace, storeId);
    if (this.#versioning !== "unversioned") {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_VERSIONING_UNSUPPORTED",
        "Versioned payload buckets are not supported.",
      );
    }
    if (!this.#bucketExists) {
      this.#bucketExists = true;
    }
    if (this.#namespace !== undefined && this.#namespace !== namespace) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_NAMESPACE_MISMATCH",
        "Payload storage namespace does not match.",
      );
    }
    if (this.#storeId !== undefined && this.#storeId !== storeId) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_STORE_MISMATCH",
        "Payload storage store ID does not match.",
      );
    }
    if (this.#namespace === undefined && this.#objects.size > 0) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_MARKER_MISSING",
        "A non-empty payload bucket has no namespace marker.",
      );
    }
    this.#namespace = namespace;
    this.#storeId = storeId;
  }

  async close(): Promise<void> {}

  simulateMissingBucket(): void {
    this.#bucketExists = false;
    this.#namespace = undefined;
    this.#storeId = undefined;
  }

  setNamespaceMarker(namespace: string | undefined, storeId?: string): void {
    this.#namespace = namespace;
    this.#storeId = storeId;
  }

  setVersioning(versioning: PayloadBucketVersioning): void {
    this.#versioning = versioning;
  }

  get(objectKey: string): PutPayloadInput | undefined {
    const value = this.#objects.get(objectKey);
    return value === undefined
      ? undefined
      : { ...value, bytes: Uint8Array.from(value.bytes) };
  }

  get lifecyclePolicy(): PayloadLifecyclePolicy | undefined {
    return this.#lifecyclePolicy === undefined
      ? undefined
      : { ...this.#lifecyclePolicy };
  }

  get size(): number {
    return this.#objects.size;
  }
}

export interface MinioPayloadStorageOptions {
  readonly bucket: string;
  readonly client?: MinioClient;
  readonly clientOptions?: ClientOptions;
  readonly region?: string;
  readonly lifecyclePolicy?: PayloadLifecyclePolicy;
}

export class MinioPayloadStorage implements PayloadStorage {
  readonly capabilities = Object.freeze({ capture: true, cleanup: true });
  readonly #bucket: string;
  readonly #client: MinioClient;
  readonly #region: string | undefined;
  readonly #initialLifecyclePolicy: PayloadLifecyclePolicy | undefined;
  #initialized = false;
  #identityNamespace: string | undefined;
  #identityStoreId: string | undefined;

  constructor(options: MinioPayloadStorageOptions) {
    if (options.client === undefined && options.clientOptions === undefined) {
      throw new RangeError("MinIO client options are required.");
    }
    if (options.lifecyclePolicy !== undefined) {
      validateLifecyclePolicy(options.lifecyclePolicy);
    }
    this.#client = options.client ?? new MinioClient(options.clientOptions!);
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#initialLifecyclePolicy = options.lifecyclePolicy;
  }

  async #applyLifecycle(policy: PayloadLifecyclePolicy): Promise<void> {
    const configuration: LifecycleConfig = {
      Rule: [
        {
          ID: "webhook-portal-payload-retention",
          Status: "Enabled",
          Filter: { Prefix: policy.prefix },
          Expiration: { Days: policy.expireAfterDays },
          ...(policy.abortIncompleteMultipartAfterDays === undefined
            ? {}
            : {
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: policy.abortIncompleteMultipartAfterDays,
                },
              }),
        },
      ],
    };
    await this.#client.setBucketLifecycle(this.#bucket, configuration);
  }

  async #bucketEmpty(): Promise<boolean> {
    const stream = this.#client.listObjectsV2(this.#bucket, "", true);
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (empty: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(empty);
        }
      };
      stream.on("data", () => {
        finish(false);
        stream.destroy();
      });
      stream.on("error", reject);
      stream.on("close", () => finish(true));
      stream.on("end", () => finish(true));
    });
  }

  async #markerIdentity(): Promise<{
    readonly namespace?: string;
    readonly storeId?: string;
  }> {
    try {
      const marker = await this.#client.statObject(
        this.#bucket,
        PAYLOAD_NAMESPACE_MARKER_KEY,
      );
      const metadata = marker.metaData as Readonly<Record<string, unknown>>;
      let namespace: string | undefined;
      let storeId: string | undefined;
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== "string" || value.length === 0) {
          continue;
        }
        const normalized = key.toLowerCase().replace(/^x-amz-meta-/u, "");
        if (normalized === "webhook-portal-namespace") {
          namespace = value;
        } else if (normalized === "webhook-portal-store-id") {
          storeId = value;
        }
      }
      return {
        ...(namespace === undefined ? {} : { namespace }),
        ...(storeId === undefined ? {} : { storeId }),
      };
    } catch (error) {
      const code = errorCode(error);
      if (
        code === "NoSuchKey" ||
        code === "NotFound" ||
        code === "NoSuchObject"
      ) {
        return {};
      }
      throw error;
    }
  }

  async inspectIdentity(): Promise<PayloadStorageIdentityInspection> {
    const bucketExists = await this.#client.bucketExists(this.#bucket);
    if (!bucketExists) {
      return {
        bucketExists: false,
        empty: true,
        versioning: "unversioned",
      };
    }
    const configuration = await this.#client.getBucketVersioning(this.#bucket);
    const versioning: PayloadBucketVersioning =
      configuration.Status === "Enabled"
        ? "enabled"
        : configuration.Status === "Suspended"
          ? "suspended"
          : "unversioned";
    const [empty, identity] = await Promise.all([
      this.#bucketEmpty(),
      this.#markerIdentity(),
    ]);
    return {
      bucketExists: true,
      empty,
      versioning,
      ...identity,
    };
  }

  async initializeIdentity(namespace: string, storeId: string): Promise<void> {
    validatePayloadStorageIdentity(namespace, storeId);
    if (this.#bucket !== payloadBucketName(namespace, storeId)) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_BUCKET_NAME_MISMATCH",
        "Payload bucket name does not match the installation namespace and physical store.",
      );
    }
    let inspection = await this.inspectIdentity();
    if (inspection.versioning !== "unversioned") {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_VERSIONING_UNSUPPORTED",
        "Versioned payload buckets are not supported.",
      );
    }
    if (!inspection.bucketExists) {
      try {
        await this.#client.makeBucket(this.#bucket, this.#region);
      } catch (error) {
        const code = errorCode(error);
        if (
          code !== "BucketAlreadyOwnedByYou" &&
          code !== "BucketAlreadyExists"
        ) {
          throw error;
        }
      }
      inspection = {
        bucketExists: true,
        empty: true,
        versioning: "unversioned",
      };
    }
    if (
      inspection.namespace !== undefined &&
      inspection.namespace !== namespace
    ) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_NAMESPACE_MISMATCH",
        "Payload storage namespace does not match.",
      );
    }
    if (inspection.storeId !== undefined && inspection.storeId !== storeId) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_STORE_MISMATCH",
        "Payload storage store ID does not match.",
      );
    }
    if (inspection.namespace === undefined) {
      if (!inspection.empty) {
        throw new PayloadStorageIdentityError(
          "PAYLOAD_STORAGE_MARKER_MISSING",
          "A non-empty payload bucket has no namespace marker.",
        );
      }
    }
    if (
      inspection.namespace === undefined ||
      inspection.storeId === undefined
    ) {
      const bytes = Buffer.from(JSON.stringify({ namespace, storeId }), "utf8");
      await this.#client.putObject(
        this.#bucket,
        PAYLOAD_NAMESPACE_MARKER_KEY,
        bytes,
        bytes.byteLength,
        {
          "content-type": "application/json",
          "x-amz-meta-webhook-portal-namespace": namespace,
          "x-amz-meta-webhook-portal-store-id": storeId,
        },
      );
    }
    if (this.#initialLifecyclePolicy !== undefined && !this.#initialized) {
      await this.#applyLifecycle(this.#initialLifecyclePolicy);
    }
    this.#identityNamespace = namespace;
    this.#identityStoreId = storeId;
    this.#initialized = true;
  }

  async #assertIdentity(): Promise<void> {
    const namespace = this.#identityNamespace;
    const storeId = this.#identityStoreId;
    if (namespace === undefined || storeId === undefined) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_IDENTITY_UNAVAILABLE",
        "Payload storage identity has not been initialized.",
      );
    }
    const inspection = await this.inspectIdentity();
    if (inspection.versioning !== "unversioned") {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_VERSIONING_UNSUPPORTED",
        "Versioned payload buckets are not supported.",
      );
    }
    if (
      !inspection.bucketExists ||
      inspection.namespace !== namespace ||
      inspection.storeId !== storeId
    ) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_IDENTITY_MISMATCH",
        "Payload storage identity does not match.",
      );
    }
  }

  async ping(): Promise<void> {
    await this.#assertIdentity();
  }

  async put(input: PutPayloadInput): Promise<void> {
    await this.#assertIdentity();
    const bytes = Buffer.from(input.bytes);
    await this.#client.putObject(
      this.#bucket,
      input.objectKey,
      bytes,
      bytes.byteLength,
      {
        "content-type": input.contentType,
        "x-amz-meta-created-at": input.createdAt,
        "x-amz-meta-expires-at": input.expiresAt,
      },
    );
  }

  async delete(objectKey: string): Promise<void> {
    await this.#assertIdentity();
    await this.#client.removeObject(this.#bucket, objectKey);
  }

  async exists(objectKey: string): Promise<boolean> {
    await this.#assertIdentity();
    try {
      await this.#client.statObject(this.#bucket, objectKey);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (
        code === "NoSuchKey" ||
        code === "NotFound" ||
        code === "NoSuchObject"
      ) {
        return false;
      }
      throw error;
    }
  }

  async listObjectKeys(
    prefix: string,
    limit: number,
  ): Promise<readonly string[]> {
    return (await this.listObjects(prefix, limit)).items.map(
      (item) => item.objectKey,
    );
  }

  async listObjects(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadObjectPage> {
    await this.#assertIdentity();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Payload object listing limit must be positive.");
    }
    const stream = this.#client.listObjectsV2(
      this.#bucket,
      prefix,
      true,
      cursor,
    );
    return new Promise<PayloadObjectPage>((resolve, reject) => {
      const items: PayloadObject[] = [];
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        const pageItems = items.slice(0, limit);
        resolve({
          items: pageItems,
          ...(items.length > limit && pageItems.length > 0
            ? {
                nextCursor: pageItems[pageItems.length - 1]!.objectKey,
              }
            : {}),
        });
      };
      stream.on("data", (item) => {
        if (items.length <= limit && item.name !== undefined) {
          items.push({
            objectKey: item.name,
            ...(item.lastModified === undefined
              ? {}
              : { createdAt: item.lastModified.toISOString() }),
          });
        }
        if (items.length > limit) {
          stream.destroy();
        }
      });
      stream.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      stream.on("close", finish);
      stream.on("end", finish);
    });
  }

  async configureLifecycle(policy: PayloadLifecyclePolicy): Promise<void> {
    validateLifecyclePolicy(policy);
    await this.#assertIdentity();
    await this.#applyLifecycle(policy);
  }

  async close(): Promise<void> {}
}

export async function ensurePayloadStorageIdentity(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  options: {
    readonly clock?: () => number | Date;
    readonly namespaceId: string;
    readonly storeId: string;
  },
): Promise<string> {
  const clock = options.clock ?? Date.now;
  const value = clock();
  const timestamp = new Date(
    value instanceof Date ? value.getTime() : value,
  ).toISOString();
  const namespace = options.namespaceId;
  const storeId = options.storeId;
  validatePayloadStorageIdentity(namespace, storeId);
  const bound = await repository.initializePayloadStorageNamespace(
    namespace,
    storeId,
    timestamp,
  );
  if (bound.storeId !== storeId) {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_STORE_MISMATCH",
      "The database is bound to another payload store.",
    );
  }
  const [hasPayloadData, inspection] = await Promise.all([
    repository.hasPayloadDataState(),
    storage.inspectIdentity(),
  ]);
  if (inspection.versioning !== "unversioned") {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_VERSIONING_UNSUPPORTED",
      "Versioned payload buckets are not supported.",
    );
  }
  if (
    inspection.namespace !== undefined &&
    inspection.namespace !== namespace
  ) {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_NAMESPACE_MISMATCH",
      "The configured payload bucket belongs to another installation.",
    );
  }
  if (inspection.namespace === undefined && inspection.storeId !== undefined) {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_MARKER_MISSING",
      "The configured payload bucket has an incomplete identity marker.",
    );
  }
  if (inspection.storeId !== undefined && inspection.storeId !== storeId) {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_STORE_MISMATCH",
      "The configured payload bucket belongs to another physical store.",
    );
  }
  if (
    bound.status === "ready" ||
    bound.status === "upgrading" ||
    hasPayloadData
  ) {
    if (!inspection.bucketExists) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_BUCKET_MISSING",
        "The configured payload bucket is missing.",
      );
    }
    if (inspection.namespace === undefined) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_MARKER_MISSING",
        "The configured payload bucket has no namespace marker.",
      );
    }
    if (inspection.namespace !== namespace) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_NAMESPACE_MISMATCH",
        "The configured payload bucket belongs to another installation.",
      );
    }
    if (bound.status === "ready" && inspection.storeId === undefined) {
      throw new PayloadStorageIdentityError(
        "PAYLOAD_STORAGE_STORE_ID_MISSING",
        "The configured payload bucket has no store ID marker.",
      );
    }
    await storage.initializeIdentity(namespace, storeId);
    await repository.markPayloadStorageNamespaceReady(
      namespace,
      storeId,
      timestamp,
    );
    return namespace;
  }
  if (
    inspection.bucketExists &&
    inspection.namespace === undefined &&
    !inspection.empty
  ) {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_MARKER_MISSING",
      "A non-empty payload bucket has no namespace marker.",
    );
  }
  if (
    inspection.namespace !== undefined &&
    inspection.namespace !== namespace
  ) {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_NAMESPACE_MISMATCH",
      "The configured payload bucket belongs to another installation.",
    );
  }
  await storage.initializeIdentity(namespace, storeId);
  await repository.markPayloadStorageNamespaceReady(
    namespace,
    storeId,
    timestamp,
  );
  return namespace;
}

export async function sweepExpiredPayloads(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  now: string,
  limit = 100,
  cursor?: string,
): Promise<PayloadSweepReport> {
  const failures: PayloadOperationFailure[] = [];
  if (!storage.capabilities.cleanup) {
    return {
      scanned: 0,
      deleted: 0,
      failures: [
        {
          operation: "list_references",
          errorCode: "payload_cleanup_unavailable",
        },
      ],
    };
  }
  let page;
  try {
    page = await repository.listExpiredPayloadReferencesPage(
      now,
      limit,
      cursor,
    );
  } catch (error) {
    return {
      scanned: 0,
      deleted: 0,
      failures: [{ operation: "list_references", errorCode: errorCode(error) }],
    };
  }
  let deleted = 0;
  for (const reference of page.items) {
    try {
      await storage.delete(reference.objectKey);
    } catch (error) {
      failures.push({
        operation: "delete_object",
        referenceId: reference.id,
        objectKey: reference.objectKey,
        errorCode: errorCode(error),
      });
      continue;
    }
    try {
      await repository.deletePayloadReference({
        id: reference.id,
        objectKey: reference.objectKey,
        uploadAttemptId: reference.uploadAttemptId,
        uploadGeneration: reference.uploadGeneration,
      });
      deleted += 1;
    } catch (error) {
      failures.push({
        operation: "delete_reference",
        referenceId: reference.id,
        errorCode: errorCode(error),
      });
    }
  }
  return {
    scanned: page.items.length,
    deleted,
    failures,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

export async function processPayloadCleanupTasks(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  now: string,
  options: {
    readonly cursor?: string;
    readonly endpointId?: string;
    readonly limit?: number;
  } = {},
): Promise<PayloadSweepReport> {
  const failures: PayloadOperationFailure[] = [];
  if (!storage.capabilities.cleanup) {
    return {
      scanned: 0,
      deleted: 0,
      failures: [
        {
          operation: "list_cleanup_tasks",
          errorCode: "payload_cleanup_unavailable",
        },
      ],
    };
  }
  const limit = options.limit ?? 100;
  let tasks;
  try {
    tasks = await repository.listPayloadCleanupTasks(
      limit + 1,
      options.endpointId,
      options.cursor,
    );
  } catch (error) {
    return {
      scanned: 0,
      deleted: 0,
      failures: [
        { operation: "list_cleanup_tasks", errorCode: errorCode(error) },
      ],
    };
  }
  const page = tasks.slice(0, limit);
  let deleted = 0;
  for (const task of page) {
    try {
      await storage.delete(task.objectKey);
    } catch (error) {
      const code = errorCode(error);
      failures.push({
        operation: "delete_object",
        cleanupTaskId: task.id,
        objectKey: task.objectKey,
        errorCode: code,
      });
      try {
        await repository.markPayloadCleanupFailed(task.id, now, code);
      } catch (markError) {
        failures.push({
          operation: "mark_cleanup_failed",
          cleanupTaskId: task.id,
          objectKey: task.objectKey,
          errorCode: errorCode(markError),
        });
      }
      continue;
    }
    try {
      await repository.completePayloadCleanup(task.id);
      deleted += 1;
    } catch (error) {
      const code = errorCode(error);
      failures.push({
        operation: "complete_cleanup",
        cleanupTaskId: task.id,
        errorCode: code,
      });
      try {
        await repository.markPayloadCleanupFailed(task.id, now, code);
      } catch (markError) {
        failures.push({
          operation: "mark_cleanup_failed",
          cleanupTaskId: task.id,
          objectKey: task.objectKey,
          errorCode: errorCode(markError),
        });
      }
    }
  }
  return {
    scanned: page.length,
    deleted,
    failures,
    ...(tasks.length > limit && page.length > 0
      ? { nextCursor: page[page.length - 1]!.id }
      : {}),
  };
}

export async function reconcileOrphanedPayloads(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  options: {
    readonly claimIdFactory?: () => string;
    readonly cleanupLeaseMilliseconds?: number;
    readonly cursor?: PayloadReconciliationCursor;
    readonly gracePeriodMilliseconds?: number;
    readonly prefix?: string;
    readonly limit?: number;
    readonly now?: string;
  } = {},
): Promise<PayloadReconciliationReport> {
  const prefix = options.prefix ?? "payloads/";
  const limit = options.limit ?? 100;
  const now = options.now ?? new Date().toISOString();
  const cutoff = new Date(
    Date.parse(now) - (options.gracePeriodMilliseconds ?? 5 * 60 * 1000),
  ).toISOString();
  const cleanupLeaseMilliseconds =
    options.cleanupLeaseMilliseconds ?? 60 * 1000;
  if (
    !Number.isSafeInteger(cleanupLeaseMilliseconds) ||
    cleanupLeaseMilliseconds < 1000
  ) {
    throw new RangeError(
      "Payload cleanup claim leases must be at least one second.",
    );
  }
  const leaseExpiresAt = new Date(
    Date.parse(now) + cleanupLeaseMilliseconds,
  ).toISOString();
  const claimIdFactory = options.claimIdFactory ?? randomUUID;
  const cycle =
    options.cursor ??
    ({
      cleanupClaims: { exhausted: false },
      objects: { exhausted: false },
      references: { exhausted: false },
      uploadIntents: { exhausted: false },
    } satisfies PayloadReconciliationCursor);
  const failures: PayloadOperationFailure[] = [];
  if (!storage.capabilities.cleanup) {
    return {
      inspectedCleanupClaims: 0,
      inspectedObjects: 0,
      inspectedReferences: 0,
      inspectedUploadIntents: 0,
      deletedOrphanObjects: 0,
      clearedDanglingReferences: 0,
      clearedUploadIntents: 0,
      deferredObjects: 0,
      cycleCompleted: false,
      failures: [
        {
          operation: "list_objects",
          errorCode: "payload_cleanup_unavailable",
        },
      ],
      nextCursor: cycle,
    };
  }
  let objectPage: PayloadObjectPage = { items: [] };
  let cleanupClaimPage: Awaited<
    ReturnType<ReferenceRepository["listExpiredPayloadCleanupClaims"]>
  > = { items: [] };
  let referencePage: Awaited<
    ReturnType<ReferenceRepository["listPayloadReferencesPage"]>
  > = { items: [] };
  let uploadIntentPage: Awaited<
    ReturnType<ReferenceRepository["listPayloadUploadIntents"]>
  > = { items: [] };
  let objectListSucceeded = cycle.objects.exhausted;
  let cleanupClaimListSucceeded = cycle.cleanupClaims.exhausted;
  let referenceListSucceeded = cycle.references.exhausted;
  let uploadIntentListSucceeded = cycle.uploadIntents.exhausted;
  if (!cycle.cleanupClaims.exhausted) {
    try {
      cleanupClaimPage = await repository.listExpiredPayloadCleanupClaims(
        now,
        limit,
        cycle.cleanupClaims.cursor,
      );
      cleanupClaimListSucceeded = true;
    } catch (error) {
      failures.push({
        operation: "list_cleanup_claims",
        errorCode: errorCode(error),
      });
    }
  }
  if (!cycle.objects.exhausted) {
    try {
      objectPage = await storage.listObjects(
        prefix,
        limit,
        cycle.objects.cursor,
      );
      objectListSucceeded = true;
    } catch (error) {
      failures.push({ operation: "list_objects", errorCode: errorCode(error) });
    }
  }
  if (!cycle.references.exhausted) {
    try {
      referencePage = await repository.listPayloadReferencesPage(
        limit,
        cycle.references.cursor,
      );
      referenceListSucceeded = true;
    } catch (error) {
      failures.push({
        operation: "list_references",
        errorCode: errorCode(error),
      });
    }
  }
  if (!cycle.uploadIntents.exhausted) {
    try {
      uploadIntentPage = await repository.listPayloadUploadIntents(
        cutoff,
        limit,
        cycle.uploadIntents.cursor,
      );
      uploadIntentListSucceeded = true;
    } catch (error) {
      failures.push({
        operation: "list_upload_intents",
        errorCode: errorCode(error),
      });
    }
  }
  let deletedOrphanObjects = 0;
  let clearedDanglingReferences = 0;
  let clearedUploadIntents = 0;
  let deferredObjects = 0;
  const handledObjectKeys = new Set<string>();

  const completeReferencedIntent = async (
    uploadIntentId: string | undefined,
    uploadGeneration: string | undefined,
    objectKey: string,
  ): Promise<void> => {
    if (uploadIntentId === undefined) {
      return;
    }
    if (uploadGeneration === undefined) {
      failures.push({
        operation: "complete_upload_intent",
        uploadIntentId,
        objectKey,
        errorCode: "upload_generation_missing",
      });
      return;
    }
    try {
      await repository.completePayloadUploadIntent(
        uploadIntentId,
        uploadGeneration,
      );
      clearedUploadIntents += 1;
    } catch (error) {
      failures.push({
        operation: "complete_upload_intent",
        uploadIntentId,
        objectKey,
        errorCode: errorCode(error),
      });
    }
  };

  const cleanClaimedObject = async (input: {
    readonly objectKey: string;
    readonly reason: "legacy_orphan" | "stale_upload_intent";
    readonly uploadIntentId?: string;
    readonly uploadGeneration?: string;
  }): Promise<void> => {
    const claimId = claimIdFactory();
    let claimed: Awaited<
      ReturnType<ReferenceRepository["claimPayloadCleanup"]>
    >;
    try {
      claimed = await repository.claimPayloadCleanup({
        objectKey: input.objectKey,
        claimId,
        reason: input.reason,
        timestamp: now,
        leaseExpiresAt,
        ...(input.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: input.uploadIntentId }),
        ...(input.uploadGeneration === undefined
          ? {}
          : { uploadGeneration: input.uploadGeneration }),
      });
    } catch (error) {
      failures.push({
        operation: "claim_cleanup",
        cleanupClaimId: claimId,
        objectKey: input.objectKey,
        errorCode: errorCode(error),
      });
      return;
    }
    if (claimed.status === "referenced") {
      await completeReferencedIntent(
        input.uploadIntentId,
        input.uploadGeneration,
        input.objectKey,
      );
      return;
    }
    if (
      claimed.status === "busy" ||
      claimed.status === "intent_missing" ||
      claimed.status === "intent_present"
    ) {
      return;
    }
    if (claimed.status === "deleted") {
      await completeReferencedIntent(
        input.uploadIntentId,
        input.uploadGeneration,
        input.objectKey,
      );
      return;
    }
    const claim = claimed.claim;
    let deleting: Awaited<
      ReturnType<ReferenceRepository["beginPayloadCleanupDeletion"]>
    >;
    try {
      deleting = await repository.beginPayloadCleanupDeletion({
        objectKey: claim.objectKey,
        claimId: claim.claimId,
        generation: claim.generation,
        timestamp: now,
        leaseExpiresAt,
        ...(claim.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: claim.uploadIntentId }),
        ...(claim.uploadGeneration === undefined
          ? {}
          : { uploadGeneration: claim.uploadGeneration }),
      });
    } catch (error) {
      failures.push({
        operation: "begin_cleanup_deletion",
        cleanupClaimId: claim.claimId,
        cleanupClaimGeneration: claim.generation,
        objectKey: claim.objectKey,
        errorCode: errorCode(error),
      });
      return;
    }
    if (deleting.status === "referenced") {
      await completeReferencedIntent(
        input.uploadIntentId,
        input.uploadGeneration,
        input.objectKey,
      );
      return;
    }
    if (deleting.status !== "deleting") {
      return;
    }
    const finalizeDeletion = async (): Promise<void> => {
      let finalized: boolean;
      try {
        finalized = await repository.finalizePayloadCleanupDeletion({
          objectKey: input.objectKey,
          claimId: claim.claimId,
          generation: claim.generation,
          timestamp: now,
          ...(claim.uploadIntentId === undefined
            ? {}
            : { uploadIntentId: claim.uploadIntentId }),
          ...(claim.uploadGeneration === undefined
            ? {}
            : { uploadGeneration: claim.uploadGeneration }),
        });
      } catch (error) {
        failures.push({
          operation: "finalize_cleanup_deletion",
          cleanupClaimId: claim.claimId,
          cleanupClaimGeneration: claim.generation,
          ...(input.uploadIntentId === undefined
            ? {}
            : { uploadIntentId: input.uploadIntentId }),
          objectKey: input.objectKey,
          errorCode: errorCode(error),
        });
        return;
      }
      if (!finalized) {
        failures.push({
          operation: "finalize_cleanup_deletion",
          cleanupClaimId: claim.claimId,
          cleanupClaimGeneration: claim.generation,
          ...(input.uploadIntentId === undefined
            ? {}
            : { uploadIntentId: input.uploadIntentId }),
          objectKey: input.objectKey,
          errorCode: "cleanup_claim_lost",
        });
        return;
      }
      deletedOrphanObjects += 1;
      if (input.uploadIntentId !== undefined) {
        clearedUploadIntents += 1;
      }
    };
    try {
      await storage.delete(input.objectKey);
    } catch (error) {
      const code = errorCode(error);
      failures.push({
        operation: "delete_object",
        cleanupClaimId: claim.claimId,
        cleanupClaimGeneration: claim.generation,
        ...(input.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: input.uploadIntentId }),
        objectKey: input.objectKey,
        errorCode: code,
      });
      let exists: boolean;
      try {
        exists = await storage.exists(input.objectKey);
      } catch (inspectionError) {
        failures.push({
          operation: "inspect_object",
          cleanupClaimId: claim.claimId,
          cleanupClaimGeneration: claim.generation,
          ...(input.uploadIntentId === undefined
            ? {}
            : { uploadIntentId: input.uploadIntentId }),
          objectKey: input.objectKey,
          errorCode: errorCode(inspectionError),
        });
        return;
      }
      if (!exists) {
        await finalizeDeletion();
      }
      return;
    }
    await finalizeDeletion();
  };

  for (const claim of cleanupClaimPage.items) {
    handledObjectKeys.add(claim.objectKey);
    await cleanClaimedObject({
      objectKey: claim.objectKey,
      reason: claim.reason,
      ...(claim.uploadIntentId === undefined
        ? {}
        : { uploadIntentId: claim.uploadIntentId }),
      ...(claim.uploadGeneration === undefined
        ? {}
        : { uploadGeneration: claim.uploadGeneration }),
    });
  }

  for (const intent of uploadIntentPage.items) {
    if (handledObjectKeys.has(intent.objectKey)) {
      continue;
    }
    handledObjectKeys.add(intent.objectKey);
    await cleanClaimedObject({
      objectKey: intent.objectKey,
      reason: "stale_upload_intent",
      uploadIntentId: intent.id,
      uploadGeneration: intent.uploadGeneration,
    });
  }

  for (const object of objectPage.items) {
    if (handledObjectKeys.has(object.objectKey)) {
      continue;
    }
    if (object.createdAt === undefined || object.createdAt > cutoff) {
      deferredObjects += 1;
      continue;
    }
    await cleanClaimedObject({
      objectKey: object.objectKey,
      reason: "legacy_orphan",
    });
  }

  for (const reference of referencePage.items) {
    if (reference.createdAt > cutoff) {
      continue;
    }
    let exists: boolean;
    try {
      exists = await storage.exists(reference.objectKey);
    } catch (error) {
      failures.push({
        operation: "inspect_object",
        referenceId: reference.id,
        objectKey: reference.objectKey,
        errorCode: errorCode(error),
      });
      continue;
    }
    if (exists) {
      continue;
    }
    try {
      await repository.deletePayloadReference({
        id: reference.id,
        objectKey: reference.objectKey,
        uploadAttemptId: reference.uploadAttemptId,
        uploadGeneration: reference.uploadGeneration,
      });
      clearedDanglingReferences += 1;
    } catch (error) {
      failures.push({
        operation: "delete_reference",
        referenceId: reference.id,
        errorCode: errorCode(error),
      });
    }
  }

  const advance = (
    current: PayloadPageStreamState,
    succeeded: boolean,
    nextCursor: string | undefined,
  ): PayloadPageStreamState => {
    if (current.exhausted || !succeeded) {
      return current;
    }
    return nextCursor === undefined
      ? { exhausted: true }
      : { exhausted: false, cursor: nextCursor };
  };
  const nextCursor: PayloadReconciliationCursor = {
    cleanupClaims: advance(
      cycle.cleanupClaims,
      cleanupClaimListSucceeded,
      cleanupClaimPage.nextCursor,
    ),
    objects: advance(cycle.objects, objectListSucceeded, objectPage.nextCursor),
    references: advance(
      cycle.references,
      referenceListSucceeded,
      referencePage.nextCursor,
    ),
    uploadIntents: advance(
      cycle.uploadIntents,
      uploadIntentListSucceeded,
      uploadIntentPage.nextCursor,
    ),
  };
  const cycleCompleted =
    nextCursor.cleanupClaims.exhausted &&
    nextCursor.objects.exhausted &&
    nextCursor.references.exhausted &&
    nextCursor.uploadIntents.exhausted;
  return {
    inspectedCleanupClaims: cleanupClaimPage.items.length,
    inspectedObjects: objectPage.items.length,
    inspectedReferences: referencePage.items.length,
    inspectedUploadIntents: uploadIntentPage.items.length,
    deletedOrphanObjects,
    clearedDanglingReferences,
    clearedUploadIntents,
    deferredObjects,
    failures,
    cycleCompleted,
    ...(cycleCompleted ? {} : { nextCursor }),
  };
}

export interface PayloadMaintenanceReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly expiry: PayloadSweepReport;
  readonly cleanup: PayloadSweepReport;
  readonly reconciliation: PayloadReconciliationReport;
  readonly failureCount: number;
  readonly cycleCompleted: boolean;
  readonly nextCursor?: PayloadMaintenanceCursor;
}

export interface PayloadMaintenanceCursor {
  readonly cleanup: PayloadPageStreamState;
  readonly expiry: PayloadPageStreamState;
  readonly reconciliation: PayloadPageStreamState<PayloadReconciliationCursor>;
}

export async function runPayloadMaintenance(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  options: {
    readonly batchSize?: number;
    readonly claimIdFactory?: () => string;
    readonly cleanupLeaseMilliseconds?: number;
    readonly clock?: () => number | Date;
    readonly cursor?: PayloadMaintenanceCursor;
    readonly gracePeriodMilliseconds?: number;
    readonly preflight?: () => Promise<void>;
  } = {},
): Promise<PayloadMaintenanceReport> {
  await options.preflight?.();
  const clock = options.clock ?? Date.now;
  const timestamp = (): string => {
    const value = clock();
    return new Date(
      value instanceof Date ? value.getTime() : value,
    ).toISOString();
  };
  const startedAt = timestamp();
  const batchSize = options.batchSize ?? 100;
  const cycle =
    options.cursor ??
    ({
      cleanup: { exhausted: false },
      expiry: { exhausted: false },
      reconciliation: { exhausted: false },
    } satisfies PayloadMaintenanceCursor);
  const [expiry, cleanup, reconciliation] = await Promise.all([
    cycle.expiry.exhausted
      ? Promise.resolve<PayloadSweepReport>({
          scanned: 0,
          deleted: 0,
          failures: [],
        })
      : sweepExpiredPayloads(
          repository,
          storage,
          startedAt,
          batchSize,
          cycle.expiry.cursor,
        ),
    cycle.cleanup.exhausted
      ? Promise.resolve<PayloadSweepReport>({
          scanned: 0,
          deleted: 0,
          failures: [],
        })
      : processPayloadCleanupTasks(repository, storage, startedAt, {
          limit: batchSize,
          ...(cycle.cleanup.cursor === undefined
            ? {}
            : { cursor: cycle.cleanup.cursor }),
        }),
    cycle.reconciliation.exhausted
      ? Promise.resolve<PayloadReconciliationReport>({
          inspectedCleanupClaims: 0,
          inspectedObjects: 0,
          inspectedReferences: 0,
          inspectedUploadIntents: 0,
          deletedOrphanObjects: 0,
          clearedDanglingReferences: 0,
          clearedUploadIntents: 0,
          deferredObjects: 0,
          failures: [],
          cycleCompleted: true,
        })
      : reconcileOrphanedPayloads(repository, storage, {
          now: startedAt,
          limit: batchSize,
          ...(options.claimIdFactory === undefined
            ? {}
            : { claimIdFactory: options.claimIdFactory }),
          ...(options.cleanupLeaseMilliseconds === undefined
            ? {}
            : {
                cleanupLeaseMilliseconds: options.cleanupLeaseMilliseconds,
              }),
          ...(cycle.reconciliation.cursor === undefined
            ? {}
            : { cursor: cycle.reconciliation.cursor }),
          ...(options.gracePeriodMilliseconds === undefined
            ? {}
            : {
                gracePeriodMilliseconds: options.gracePeriodMilliseconds,
              }),
        }),
  ]);
  const advance = (
    current: PayloadPageStreamState,
    listFailed: boolean,
    nextCursor: string | undefined,
  ): PayloadPageStreamState => {
    if (current.exhausted || listFailed) {
      return current;
    }
    return nextCursor === undefined
      ? { exhausted: true }
      : { exhausted: false, cursor: nextCursor };
  };
  const nextCursor: PayloadMaintenanceCursor = {
    expiry: advance(
      cycle.expiry,
      expiry.failures.some(
        (failure) => failure.operation === "list_references",
      ),
      expiry.nextCursor,
    ),
    cleanup: advance(
      cycle.cleanup,
      cleanup.failures.some(
        (failure) => failure.operation === "list_cleanup_tasks",
      ),
      cleanup.nextCursor,
    ),
    reconciliation: cycle.reconciliation.exhausted
      ? cycle.reconciliation
      : reconciliation.cycleCompleted
        ? { exhausted: true }
        : { exhausted: false, cursor: reconciliation.nextCursor! },
  };
  const cycleCompleted =
    nextCursor.expiry.exhausted &&
    nextCursor.cleanup.exhausted &&
    nextCursor.reconciliation.exhausted;
  return {
    startedAt,
    completedAt: timestamp(),
    expiry,
    cleanup,
    reconciliation,
    failureCount:
      expiry.failures.length +
      cleanup.failures.length +
      reconciliation.failures.length,
    cycleCompleted,
    ...(cycleCompleted ? {} : { nextCursor }),
  };
}

export interface PayloadMaintenanceStatus {
  readonly running: boolean;
  readonly degraded: boolean;
  readonly lastReport?: PayloadMaintenanceReport;
  readonly lastErrorCode?: string;
  readonly lastFailureAt?: string;
  readonly lastFailureCount?: number;
}

export interface PayloadMaintenanceController {
  runNow(): Promise<PayloadMaintenanceReport>;
  status(): PayloadMaintenanceStatus;
  stop(): Promise<void>;
}

export function startPayloadMaintenance(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  options: {
    readonly batchSize?: number;
    readonly claimIdFactory?: () => string;
    readonly cleanupLeaseMilliseconds?: number;
    readonly clock?: () => number | Date;
    readonly gracePeriodMilliseconds?: number;
    readonly intervalMilliseconds?: number;
    readonly onError?: (errorCode: string) => void;
    readonly onReport?: (report: PayloadMaintenanceReport) => void;
    readonly preflight?: () => Promise<void>;
    readonly runOnStart?: boolean;
  } = {},
): PayloadMaintenanceController {
  let active: Promise<PayloadMaintenanceReport> | undefined;
  let lastReport: PayloadMaintenanceReport | undefined;
  let lastErrorCode: string | undefined;
  let lastFailureAt: string | undefined;
  let lastFailureCount: number | undefined;
  let currentCycleFailureCount = 0;
  let cursor: PayloadMaintenanceCursor | undefined;
  const now = (): string => {
    const value = (options.clock ?? Date.now)();
    return new Date(
      value instanceof Date ? value.getTime() : value,
    ).toISOString();
  };
  const runNow = (): Promise<PayloadMaintenanceReport> => {
    if (active !== undefined) {
      return active;
    }
    active = runPayloadMaintenance(repository, storage, {
      ...options,
      ...(cursor === undefined ? {} : { cursor }),
    })
      .then((report) => {
        lastReport = report;
        cursor = report.cycleCompleted ? undefined : report.nextCursor;
        currentCycleFailureCount += report.failureCount;
        if (report.failureCount > 0) {
          lastFailureAt = report.completedAt;
          lastFailureCount = currentCycleFailureCount;
        }
        if (report.cycleCompleted) {
          if (currentCycleFailureCount === 0) {
            lastErrorCode = undefined;
            lastFailureAt = undefined;
            lastFailureCount = undefined;
          }
          currentCycleFailureCount = 0;
        }
        options.onReport?.(report);
        return report;
      })
      .catch((error: unknown) => {
        lastErrorCode = errorCode(error);
        lastFailureAt = now();
        lastFailureCount = 1;
        currentCycleFailureCount += 1;
        options.onError?.(lastErrorCode);
        throw error;
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const intervalMilliseconds = options.intervalMilliseconds ?? 60_000;
  if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1) {
    throw new RangeError("Payload maintenance interval must be positive.");
  }
  const timer = setInterval(() => {
    void runNow().catch(() => {});
  }, intervalMilliseconds);
  timer.unref();
  if (options.runOnStart !== false) {
    void runNow().catch(() => {});
  }
  return {
    runNow,
    status: () => ({
      running: active !== undefined,
      degraded:
        lastErrorCode !== undefined ||
        (lastFailureCount !== undefined && lastFailureCount > 0),
      ...(lastReport === undefined ? {} : { lastReport }),
      ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
      ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
      ...(lastFailureCount === undefined ? {} : { lastFailureCount }),
    }),
    stop: async () => {
      clearInterval(timer);
      await active;
    },
  };
}
