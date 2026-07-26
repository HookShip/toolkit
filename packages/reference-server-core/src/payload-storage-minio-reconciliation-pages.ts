// SPDX-License-Identifier: Apache-2.0

import type { ReferenceRepository } from "./types.js";
import {
  errorCode,
  type PayloadCleanupStorage,
  type PayloadObjectPage,
  type PayloadOperationFailure,
  type PayloadPageStreamState,
  type PayloadReconciliationCursor,
  type PayloadReconciliationReport,
} from "./payload-storage-types.js";

export type CleanupClaimPage = Awaited<
  ReturnType<ReferenceRepository["listExpiredPayloadCleanupClaims"]>
>;
export type PayloadReferencePage = Awaited<
  ReturnType<ReferenceRepository["listPayloadReferencesPage"]>
>;
export type UploadIntentPage = Awaited<
  ReturnType<ReferenceRepository["listPayloadUploadIntents"]>
>;

export type ReconciliationCounters = {
  deletedOrphanObjects: number;
  clearedDanglingReferences: number;
  clearedUploadIntents: number;
  deferredObjects: number;
};

export type ReconciliationPages = {
  objectPage: PayloadObjectPage;
  cleanupClaimPage: CleanupClaimPage;
  referencePage: PayloadReferencePage;
  uploadIntentPage: UploadIntentPage;
  objectListSucceeded: boolean;
  cleanupClaimListSucceeded: boolean;
  referenceListSucceeded: boolean;
  uploadIntentListSucceeded: boolean;
};

export function payloadCleanupUnavailableReport(
  cycle: PayloadReconciliationCursor,
): PayloadReconciliationReport {
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

export async function listReconciliationPages(
  repository: ReferenceRepository,
  storage: PayloadCleanupStorage,
  prefix: string,
  limit: number,
  now: string,
  cutoff: string,
  cycle: PayloadReconciliationCursor,
  failures: PayloadOperationFailure[],
): Promise<ReconciliationPages> {
  let objectPage: PayloadObjectPage = { items: [] };
  let cleanupClaimPage: CleanupClaimPage = { items: [] };
  let referencePage: PayloadReferencePage = { items: [] };
  let uploadIntentPage: UploadIntentPage = { items: [] };
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
  return {
    objectPage,
    cleanupClaimPage,
    referencePage,
    uploadIntentPage,
    objectListSucceeded,
    cleanupClaimListSucceeded,
    referenceListSucceeded,
    uploadIntentListSucceeded,
  };
}

function advance(
  current: PayloadPageStreamState,
  succeeded: boolean,
  nextCursor: string | undefined,
): PayloadPageStreamState {
  if (current.exhausted || !succeeded) {
    return current;
  }
  return nextCursor === undefined
    ? { exhausted: true }
    : { exhausted: false, cursor: nextCursor };
}

export function reconciliationReport(
  cycle: PayloadReconciliationCursor,
  pages: ReconciliationPages,
  counters: ReconciliationCounters,
  failures: PayloadOperationFailure[],
): PayloadReconciliationReport {
  const nextCursor: PayloadReconciliationCursor = {
    cleanupClaims: advance(
      cycle.cleanupClaims,
      pages.cleanupClaimListSucceeded,
      pages.cleanupClaimPage.nextCursor,
    ),
    objects: advance(
      cycle.objects,
      pages.objectListSucceeded,
      pages.objectPage.nextCursor,
    ),
    references: advance(
      cycle.references,
      pages.referenceListSucceeded,
      pages.referencePage.nextCursor,
    ),
    uploadIntents: advance(
      cycle.uploadIntents,
      pages.uploadIntentListSucceeded,
      pages.uploadIntentPage.nextCursor,
    ),
  };
  const cycleCompleted =
    nextCursor.cleanupClaims.exhausted &&
    nextCursor.objects.exhausted &&
    nextCursor.references.exhausted &&
    nextCursor.uploadIntents.exhausted;
  return {
    inspectedCleanupClaims: pages.cleanupClaimPage.items.length,
    inspectedObjects: pages.objectPage.items.length,
    inspectedReferences: pages.referencePage.items.length,
    inspectedUploadIntents: pages.uploadIntentPage.items.length,
    deletedOrphanObjects: counters.deletedOrphanObjects,
    clearedDanglingReferences: counters.clearedDanglingReferences,
    clearedUploadIntents: counters.clearedUploadIntents,
    deferredObjects: counters.deferredObjects,
    failures,
    cycleCompleted,
    ...(cycleCompleted ? {} : { nextCursor }),
  };
}
