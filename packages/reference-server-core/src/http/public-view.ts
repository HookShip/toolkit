// SPDX-License-Identifier: Apache-2.0

import type {
  PayloadMaintenanceController,
  PayloadMaintenanceStatus,
  PayloadStorageCapabilities,
} from "../payload-storage.js";
import type {
  PayloadCleanupTask,
  PublishCommandRecord,
  RepositoryReadiness,
  TestCommandRecord,
} from "../types.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function publicTestCommand(command: TestCommandRecord) {
  const evidenceStatus =
    command.evidenceState === "complete"
      ? command.result?.state === "unknown"
        ? "unknown"
        : "completed"
      : command.pendingResult !== undefined
        ? "pending"
        : command.state === "requested"
          ? "requested"
          : "pending";
  return {
    id: command.id,
    endpointId: command.endpointId,
    eventType: command.eventType,
    state: command.state,
    evidence: {
      status: evidenceStatus,
      state: command.evidenceState,
      ...(command.resultObservedAt === undefined
        ? {}
        : { observedAt: command.resultObservedAt }),
      ...(command.pendingResult === undefined
        ? {}
        : { observedResult: command.pendingResult }),
    },
    releaseId: command.context.releaseId,
    version: command.context.eventVersion,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    ...(command.dispatchedAt === undefined
      ? {}
      : { dispatchedAt: command.dispatchedAt }),
    ...(command.result === undefined ? {} : { result: command.result }),
  };
}

export function publicPublishCommand(command: PublishCommandRecord) {
  return {
    id: command.id,
    importId: command.importId,
    requestFingerprint: command.requestFingerprint,
    state: command.state,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    ...(command.predecessorReleaseId === undefined
      ? {}
      : { predecessorReleaseId: command.predecessorReleaseId }),
    ...(command.releaseId === undefined
      ? {}
      : { releaseId: command.releaseId }),
  };
}

export function publicCleanupTask(task: PayloadCleanupTask) {
  return {
    id: task.id,
    reason: task.reason,
    state: task.state,
    attempts: task.attempts,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: task.lastErrorCode }),
  };
}

export interface PublicPayloadMaintenanceStatus {
  readonly enabled: boolean;
  readonly captureEnabled: boolean;
  readonly ready: boolean;
  readonly state: "degraded" | "disabled" | "ready" | "running" | "starting";
  readonly storageCapabilities: PayloadStorageCapabilities;
  readonly paginationPending: boolean;
  readonly lastRun?: {
    readonly startedAt: string;
    readonly completedAt: string;
    readonly failureCount: number;
    readonly expiredDeleted: number;
    readonly cleanupDeleted: number;
    readonly orphanObjectsDeleted: number;
    readonly danglingReferencesCleared: number;
    readonly uploadIntentsCleared: number;
  };
  readonly lastFailure?: {
    readonly at: string;
    readonly count: number;
    readonly errorCode?: string;
  };
}

export function publicPayloadMaintenanceStatus(
  controller: PayloadMaintenanceController | undefined,
  capabilities: PayloadStorageCapabilities,
  captureEnabled: boolean,
  cleanupRequiredWithoutStorage: boolean,
): PublicPayloadMaintenanceStatus {
  if (controller === undefined) {
    return {
      enabled: false,
      captureEnabled,
      ready: !cleanupRequiredWithoutStorage,
      state: cleanupRequiredWithoutStorage ? "degraded" : "disabled",
      storageCapabilities: capabilities,
      paginationPending: false,
    };
  }
  const status: PayloadMaintenanceStatus = controller.status();
  const lastReport = status.lastReport;
  const ready = !status.degraded && lastReport !== undefined;
  return {
    enabled: true,
    captureEnabled,
    ready,
    state: status.degraded
      ? "degraded"
      : status.running
        ? "running"
        : lastReport === undefined
          ? "starting"
          : "ready",
    storageCapabilities: capabilities,
    paginationPending: lastReport?.nextCursor !== undefined,
    ...(lastReport === undefined
      ? {}
      : {
          lastRun: {
            startedAt: lastReport.startedAt,
            completedAt: lastReport.completedAt,
            failureCount: lastReport.failureCount,
            expiredDeleted: lastReport.expiry.deleted,
            cleanupDeleted: lastReport.cleanup.deleted,
            orphanObjectsDeleted:
              lastReport.reconciliation.deletedOrphanObjects,
            danglingReferencesCleared:
              lastReport.reconciliation.clearedDanglingReferences,
            uploadIntentsCleared:
              lastReport.reconciliation.clearedUploadIntents,
          },
        }),
    ...(status.lastFailureAt === undefined ||
    status.lastFailureCount === undefined
      ? {}
      : {
          lastFailure: {
            at: status.lastFailureAt,
            count: status.lastFailureCount,
            ...(status.lastErrorCode === undefined
              ? {}
              : { errorCode: status.lastErrorCode }),
          },
        }),
  };
}

export function publicSchemaReadiness(readiness: RepositoryReadiness) {
  return {
    expectedVersion: readiness.expectedSchemaVersion,
    currentVersion: readiness.currentSchemaVersion ?? null,
    missingVersions: readiness.missingSchemaVersions,
    unexpectedVersions: readiness.unexpectedSchemaVersions,
    checksumMismatchVersions: readiness.checksumMismatches.map(
      (entry) => entry.version,
    ),
  };
}

export function payloadMaintenanceMetrics(
  status: PublicPayloadMaintenanceStatus,
): string {
  const lastRun = status.lastRun;
  const lastCompletedSeconds =
    lastRun === undefined ? 0 : Date.parse(lastRun.completedAt) / 1000;
  const lines = [
    "# HELP webhook_portal_payload_capture_enabled Whether new payload capture is enabled.",
    "# TYPE webhook_portal_payload_capture_enabled gauge",
    `webhook_portal_payload_capture_enabled ${status.captureEnabled ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_enabled Whether cleanup-capable object storage is configured.",
    "# TYPE webhook_portal_payload_maintenance_enabled gauge",
    `webhook_portal_payload_maintenance_enabled ${status.enabled ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_ready Whether the latest maintenance cycle is healthy.",
    "# TYPE webhook_portal_payload_maintenance_ready gauge",
    `webhook_portal_payload_maintenance_ready ${status.ready ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_degraded Whether maintenance has an uncleared failure.",
    "# TYPE webhook_portal_payload_maintenance_degraded gauge",
    `webhook_portal_payload_maintenance_degraded ${status.state === "degraded" ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_pagination_pending Whether another bounded page remains.",
    "# TYPE webhook_portal_payload_maintenance_pagination_pending gauge",
    `webhook_portal_payload_maintenance_pagination_pending ${status.paginationPending ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_last_completed_timestamp_seconds Last completed maintenance page.",
    "# TYPE webhook_portal_payload_maintenance_last_completed_timestamp_seconds gauge",
    `webhook_portal_payload_maintenance_last_completed_timestamp_seconds ${Number.isFinite(lastCompletedSeconds) ? lastCompletedSeconds : 0}`,
    "# HELP webhook_portal_payload_maintenance_last_failure_count Failure count retained from the latest unhealthy page.",
    "# TYPE webhook_portal_payload_maintenance_last_failure_count gauge",
    `webhook_portal_payload_maintenance_last_failure_count ${status.lastFailure?.count ?? 0}`,
    "# HELP webhook_portal_payload_maintenance_last_run_deleted_objects Objects deleted by the latest maintenance page.",
    "# TYPE webhook_portal_payload_maintenance_last_run_deleted_objects gauge",
    `webhook_portal_payload_maintenance_last_run_deleted_objects ${
      (lastRun?.expiredDeleted ?? 0) +
      (lastRun?.cleanupDeleted ?? 0) +
      (lastRun?.orphanObjectsDeleted ?? 0)
    }`,
  ];
  return `${lines.join("\n")}\n`;
}
