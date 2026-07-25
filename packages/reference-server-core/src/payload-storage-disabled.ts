// SPDX-License-Identifier: Apache-2.0

import type {
  PayloadObjectPage,
  PayloadStorage,
  PayloadStorageIdentityInspection,
} from "./payload-storage-types.js";
import { PayloadStorageIdentityError } from "./payload-storage-types.js";

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
