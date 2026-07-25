// SPDX-License-Identifier: Apache-2.0

import { Client as MinioClient, type ClientOptions } from "minio";

import {
  applyMinioPayloadLifecycle,
  assertMinioPayloadStorageIdentity,
  initializeMinioPayloadStorageIdentity,
  inspectMinioPayloadStorageIdentity,
} from "./payload-storage-minio-identity.js";
import {
  errorCode,
  validateLifecyclePolicy,
  type PayloadLifecyclePolicy,
  type PayloadObject,
  type PayloadObjectPage,
  type PayloadStorage,
  type PayloadStorageIdentityInspection,
  type PutPayloadInput,
} from "./payload-storage-types.js";

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

  async inspectIdentity(): Promise<PayloadStorageIdentityInspection> {
    return inspectMinioPayloadStorageIdentity(this.#client, this.#bucket);
  }

  async initializeIdentity(namespace: string, storeId: string): Promise<void> {
    const state = await initializeMinioPayloadStorageIdentity(
      this.#client,
      this.#bucket,
      this.#region,
      this.#initialLifecyclePolicy,
      this.#initialized,
      namespace,
      storeId,
    );
    this.#identityNamespace = state.identityNamespace;
    this.#identityStoreId = state.identityStoreId;
    this.#initialized = state.initialized;
  }

  async #assertIdentity(): Promise<void> {
    await assertMinioPayloadStorageIdentity(
      this.#client,
      this.#bucket,
      this.#identityNamespace,
      this.#identityStoreId,
    );
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
    await applyMinioPayloadLifecycle(this.#client, this.#bucket, policy);
  }

  async close(): Promise<void> {}
}
