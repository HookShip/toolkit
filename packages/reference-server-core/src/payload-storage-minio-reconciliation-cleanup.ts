// SPDX-License-Identifier: Apache-2.0

import type { PayloadCleanupClaim, ReferenceRepository } from "./types.js";
import {
  errorCode,
  type PayloadCleanupStorage,
  type PayloadObjectPage,
  type PayloadOperationFailure,
} from "./payload-storage-types.js";
import type {
  CleanupClaimPage,
  PayloadReferencePage,
  ReconciliationCounters,
  UploadIntentPage,
} from "./payload-storage-minio-reconciliation-pages.js";

async function completeReferencedIntent(
  repository: ReferenceRepository,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  uploadIntentId: string | undefined,
  uploadGeneration: string | undefined,
  objectKey: string,
): Promise<void> {
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
    counters.clearedUploadIntents += 1;
  } catch (error) {
    failures.push({
      operation: "complete_upload_intent",
      uploadIntentId,
      objectKey,
      errorCode: errorCode(error),
    });
  }
}

type CleanClaimedObjectInput = {
  readonly objectKey: string;
  readonly reason: "legacy_orphan" | "stale_upload_intent";
  readonly uploadIntentId?: string;
  readonly uploadGeneration?: string;
};

async function cleanClaimedObject(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  claimIdFactory: () => string,
  now: string,
  leaseExpiresAt: string,
  input: CleanClaimedObjectInput,
): Promise<void> {
  const claimId = claimIdFactory();
  let claimed: Awaited<ReturnType<ReferenceRepository["claimPayloadCleanup"]>>;
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
      repository,
      failures,
      counters,
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
      repository,
      failures,
      counters,
      input.uploadIntentId,
      input.uploadGeneration,
      input.objectKey,
    );
    return;
  }
  await deleteClaimedObject(
    repository,
    storage,
    failures,
    counters,
    now,
    leaseExpiresAt,
    input,
    claimed.claim,
  );
}

async function deleteClaimedObject(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  now: string,
  leaseExpiresAt: string,
  input: CleanClaimedObjectInput,
  claim: PayloadCleanupClaim,
): Promise<void> {
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
      repository,
      failures,
      counters,
      input.uploadIntentId,
      input.uploadGeneration,
      input.objectKey,
    );
    return;
  }
  if (deleting.status !== "deleting") {
    return;
  }
  try {
    await storage.delete(input.objectKey);
  } catch (error) {
    await inspectAfterDeleteFailure(
      repository,
      storage,
      failures,
      counters,
      now,
      input,
      claim,
      error,
    );
    return;
  }
  await finalizeDeletion(repository, failures, counters, now, input, claim);
}

async function inspectAfterDeleteFailure(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  now: string,
  input: CleanClaimedObjectInput,
  claim: PayloadCleanupClaim,
  error: unknown,
): Promise<void> {
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
    await finalizeDeletion(repository, failures, counters, now, input, claim);
  }
}

async function finalizeDeletion(
  repository: ReferenceRepository,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  now: string,
  input: CleanClaimedObjectInput,
  claim: PayloadCleanupClaim,
): Promise<void> {
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
  counters.deletedOrphanObjects += 1;
  if (input.uploadIntentId !== undefined) {
    counters.clearedUploadIntents += 1;
  }
}

export async function cleanExpiredCleanupClaims(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  cleanupClaimPage: CleanupClaimPage,
  handledObjectKeys: Set<string>,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  claimIdFactory: () => string,
  now: string,
  leaseExpiresAt: string,
): Promise<void> {
  for (const claim of cleanupClaimPage.items) {
    handledObjectKeys.add(claim.objectKey);
    await cleanClaimedObject(
      repository,
      storage,
      failures,
      counters,
      claimIdFactory,
      now,
      leaseExpiresAt,
      {
        objectKey: claim.objectKey,
        reason: claim.reason,
        ...(claim.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: claim.uploadIntentId }),
        ...(claim.uploadGeneration === undefined
          ? {}
          : { uploadGeneration: claim.uploadGeneration }),
      },
    );
  }
}

export async function cleanStaleUploadIntents(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  uploadIntentPage: UploadIntentPage,
  handledObjectKeys: Set<string>,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  claimIdFactory: () => string,
  now: string,
  leaseExpiresAt: string,
): Promise<void> {
  for (const intent of uploadIntentPage.items) {
    if (handledObjectKeys.has(intent.objectKey)) {
      continue;
    }
    handledObjectKeys.add(intent.objectKey);
    await cleanClaimedObject(
      repository,
      storage,
      failures,
      counters,
      claimIdFactory,
      now,
      leaseExpiresAt,
      {
        objectKey: intent.objectKey,
        reason: "stale_upload_intent",
        uploadIntentId: intent.id,
        uploadGeneration: intent.uploadGeneration,
      },
    );
  }
}

export async function cleanLegacyObjects(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  objectPage: PayloadObjectPage,
  handledObjectKeys: Set<string>,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  claimIdFactory: () => string,
  now: string,
  leaseExpiresAt: string,
  cutoff: string,
): Promise<void> {
  for (const object of objectPage.items) {
    if (handledObjectKeys.has(object.objectKey)) {
      continue;
    }
    if (object.createdAt === undefined || object.createdAt > cutoff) {
      counters.deferredObjects += 1;
      continue;
    }
    await cleanClaimedObject(
      repository,
      storage,
      failures,
      counters,
      claimIdFactory,
      now,
      leaseExpiresAt,
      {
        objectKey: object.objectKey,
        reason: "legacy_orphan",
      },
    );
  }
}

export async function clearDanglingReferences(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  referencePage: PayloadReferencePage,
  failures: PayloadOperationFailure[],
  counters: ReconciliationCounters,
  cutoff: string,
): Promise<void> {
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
      counters.clearedDanglingReferences += 1;
    } catch (error) {
      failures.push({
        operation: "delete_reference",
        referenceId: reference.id,
        errorCode: errorCode(error),
      });
    }
  }
}
