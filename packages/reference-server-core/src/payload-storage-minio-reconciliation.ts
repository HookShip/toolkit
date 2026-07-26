// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import type { ReferenceRepository } from "./types.js";
import {
  PayloadStorageIdentityError,
  errorCode,
  validatePayloadStorageIdentity,
  type PayloadCleanupStorage,
  type PayloadOperationFailure,
  type PayloadReconciliationCursor,
  type PayloadReconciliationReport,
  type PayloadSweepReport,
} from "./payload-storage-types.js";

import {
  cleanExpiredCleanupClaims,
  cleanLegacyObjects,
  cleanStaleUploadIntents,
  clearDanglingReferences,
} from "./payload-storage-minio-reconciliation-cleanup.js";
import {
  listReconciliationPages,
  payloadCleanupUnavailableReport,
  reconciliationReport,
  type ReconciliationCounters,
} from "./payload-storage-minio-reconciliation-pages.js";

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
    return payloadCleanupUnavailableReport(cycle);
  }
  const pages = await listReconciliationPages(
    repository,
    storage,
    prefix,
    limit,
    now,
    cutoff,
    cycle,
    failures,
  );
  const counters: ReconciliationCounters = {
    deletedOrphanObjects: 0,
    clearedDanglingReferences: 0,
    clearedUploadIntents: 0,
    deferredObjects: 0,
  };
  const handledObjectKeys = new Set<string>();
  await cleanExpiredCleanupClaims(
    repository,
    storage,
    pages.cleanupClaimPage,
    handledObjectKeys,
    failures,
    counters,
    claimIdFactory,
    now,
    leaseExpiresAt,
  );
  await cleanStaleUploadIntents(
    repository,
    storage,
    pages.uploadIntentPage,
    handledObjectKeys,
    failures,
    counters,
    claimIdFactory,
    now,
    leaseExpiresAt,
  );
  await cleanLegacyObjects(
    repository,
    storage,
    pages.objectPage,
    handledObjectKeys,
    failures,
    counters,
    claimIdFactory,
    now,
    leaseExpiresAt,
    cutoff,
  );
  await clearDanglingReferences(
    repository,
    storage,
    pages.referencePage,
    failures,
    counters,
    cutoff,
  );
  return reconciliationReport(cycle, pages, counters, failures);
}
