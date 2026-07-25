// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnits } from "./ordering.js";
import {
  PayloadStorageIdentityError,
  validateLifecyclePolicy,
  validatePayloadStorageIdentity,
  type PayloadBucketVersioning,
  type PayloadLifecyclePolicy,
  type PayloadObjectPage,
  type PayloadStorage,
  type PayloadStorageIdentityInspection,
  type PutPayloadInput,
} from "./payload-storage-types.js";

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
