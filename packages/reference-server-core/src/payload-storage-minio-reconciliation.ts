// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import type { ReferenceRepository } from "./types.js";
import {
  PayloadStorageIdentityError,
  errorCode,
  validatePayloadStorageIdentity,
  type PayloadCleanupStorage,
  type PayloadObjectPage,
  type PayloadOperationFailure,
  type PayloadPageStreamState,
  type PayloadReconciliationCursor,
  type PayloadReconciliationReport,
  type PayloadSweepReport,
} from "./payload-storage-types.js";

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
