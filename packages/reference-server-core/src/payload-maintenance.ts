// SPDX-License-Identifier: Apache-2.0

import type { ReferenceRepository } from "./types.js";
import {
  errorCode,
  type PayloadCleanupStorage,
  type PayloadPageStreamState,
  type PayloadReconciliationCursor,
  type PayloadReconciliationReport,
  type PayloadSweepReport,
} from "./payload-storage-types.js";
import {
  processPayloadCleanupTasks,
  reconcileOrphanedPayloads,
  sweepExpiredPayloads,
} from "./payload-storage-minio-reconciliation.js";

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
