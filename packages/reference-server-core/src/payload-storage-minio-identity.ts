// SPDX-License-Identifier: Apache-2.0

import type { Client as MinioClient, LifecycleConfig } from "minio";

import {
  PAYLOAD_NAMESPACE_MARKER_KEY,
  PayloadStorageIdentityError,
  errorCode,
  payloadBucketName,
  validateLifecyclePolicy,
  validatePayloadStorageIdentity,
  type PayloadBucketVersioning,
  type PayloadLifecyclePolicy,
  type PayloadStorageIdentityInspection,
} from "./payload-storage-types.js";

export async function applyMinioPayloadLifecycle(
  client: MinioClient,
  bucket: string,
  policy: PayloadLifecyclePolicy,
): Promise<void> {
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
  await client.setBucketLifecycle(bucket, configuration);
}

export async function minioPayloadBucketEmpty(
  client: MinioClient,
  bucket: string,
): Promise<boolean> {
  const stream = client.listObjectsV2(bucket, "", true);
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

export async function minioPayloadMarkerIdentity(
  client: MinioClient,
  bucket: string,
): Promise<{
  readonly namespace?: string;
  readonly storeId?: string;
}> {
  try {
    const marker = await client.statObject(
      bucket,
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

export async function inspectMinioPayloadStorageIdentity(
  client: MinioClient,
  bucket: string,
): Promise<PayloadStorageIdentityInspection> {
  const bucketExists = await client.bucketExists(bucket);
  if (!bucketExists) {
    return {
      bucketExists: false,
      empty: true,
      versioning: "unversioned",
    };
  }
  const configuration = await client.getBucketVersioning(bucket);
  const versioning: PayloadBucketVersioning =
    configuration.Status === "Enabled"
      ? "enabled"
      : configuration.Status === "Suspended"
        ? "suspended"
        : "unversioned";
  const [empty, identity] = await Promise.all([
    minioPayloadBucketEmpty(client, bucket),
    minioPayloadMarkerIdentity(client, bucket),
  ]);
  return {
    bucketExists: true,
    empty,
    versioning,
    ...identity,
  };
}

export async function initializeMinioPayloadStorageIdentity(
  client: MinioClient,
  bucket: string,
  region: string | undefined,
  initialLifecyclePolicy: PayloadLifecyclePolicy | undefined,
  initialized: boolean,
  namespace: string,
  storeId: string,
): Promise<{
  readonly identityNamespace: string;
  readonly identityStoreId: string;
  readonly initialized: boolean;
}> {
  validatePayloadStorageIdentity(namespace, storeId);
  if (bucket !== payloadBucketName(namespace, storeId)) {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_BUCKET_NAME_MISMATCH",
      "Payload bucket name does not match the installation namespace and physical store.",
    );
  }
  let inspection = await inspectMinioPayloadStorageIdentity(client, bucket);
  if (inspection.versioning !== "unversioned") {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_VERSIONING_UNSUPPORTED",
      "Versioned payload buckets are not supported.",
    );
  }
  if (!inspection.bucketExists) {
    try {
      await client.makeBucket(bucket, region);
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
  if (inspection.namespace === undefined || inspection.storeId === undefined) {
    const bytes = Buffer.from(JSON.stringify({ namespace, storeId }), "utf8");
    await client.putObject(
      bucket,
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
  if (initialLifecyclePolicy !== undefined && !initialized) {
    validateLifecyclePolicy(initialLifecyclePolicy);
    await applyMinioPayloadLifecycle(client, bucket, initialLifecyclePolicy);
  }
  return {
    identityNamespace: namespace,
    identityStoreId: storeId,
    initialized: true,
  };
}

export async function assertMinioPayloadStorageIdentity(
  client: MinioClient,
  bucket: string,
  identityNamespace: string | undefined,
  identityStoreId: string | undefined,
): Promise<void> {
  const namespace = identityNamespace;
  const storeId = identityStoreId;
  if (namespace === undefined || storeId === undefined) {
    throw new PayloadStorageIdentityError(
      "PAYLOAD_STORAGE_IDENTITY_UNAVAILABLE",
      "Payload storage identity has not been initialized.",
    );
  }
  const inspection = await inspectMinioPayloadStorageIdentity(client, bucket);
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
