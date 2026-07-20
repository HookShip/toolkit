// SPDX-License-Identifier: Apache-2.0

import {
  useId,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { classNames } from "./internal.js";
import { Badge } from "./primitives.js";
import type {
  BackendCapabilityCell,
  BackendCapabilityDimension,
  BackendCapabilityStatus,
  BackendCapabilitySummary,
  BackendSelectionIssue,
} from "./types.js";

/**
 * Canonical, stable comparison dimensions. Consumers may pass their own subset
 * or superset, but these ids match the tradeoffs a delivery backend declares:
 * durability, consistency, acknowledgement barrier, ordering, retry, fencing,
 * replay, dead-letter queue, multi-replica safety, required external services,
 * and supported deployment modes.
 */
export const BACKEND_CAPABILITY_DIMENSIONS: readonly BackendCapabilityDimension[] =
  Object.freeze([
    {
      description: "Where accepted events survive: memory, disk, or replicas.",
      id: "durability",
      label: "Durability",
    },
    {
      description: "Read-after-write guarantee across processes.",
      id: "consistency",
      label: "Consistency",
    },
    {
      description: "Whether a durable acknowledgement barrier is enforced.",
      id: "ack-barrier",
      label: "Acknowledgement barrier",
    },
    {
      description: "Scope within which delivery order is preserved.",
      id: "ordering",
      label: "Ordering",
    },
    {
      description: "Retry and backoff execution semantics.",
      id: "retry",
      label: "Retry",
    },
    {
      description: "Lease and fencing protection for concurrent workers.",
      id: "fencing",
      label: "Lease / fencing",
    },
    {
      description: "Replay and redrive of prior deliveries.",
      id: "replay",
      label: "Replay / redrive",
    },
    {
      description: "Dead-letter capture for exhausted deliveries.",
      id: "dlq",
      label: "Dead-letter queue",
    },
    {
      description: "Safety when running multiple API/worker replicas.",
      id: "multi-replica",
      label: "Multi-replica",
    },
    {
      description: "External services the backend requires to operate.",
      id: "external-service",
      label: "External services",
    },
    {
      description: "Deployment modes the backend supports.",
      id: "deployment",
      label: "Deployment modes",
    },
  ]);

const STATUS_ORDER: Record<BackendCapabilityStatus, number> = {
  degraded: 2,
  experimental: 1,
  supported: 0,
  unsupported: 3,
};

/**
 * Orders backends from most to least capable overall status. Stable and
 * server-safe; callers can pre-sort matrix columns deterministically.
 */
export function compareBackendStatus(
  left: BackendCapabilityStatus,
  right: BackendCapabilityStatus,
): number {
  return STATUS_ORDER[left] - STATUS_ORDER[right];
}

export function backendStatusTone(
  status: BackendCapabilityStatus,
): "critical" | "info" | "positive" | "warning" {
  switch (status) {
    case "supported":
      return "positive";
    case "experimental":
      return "info";
    case "degraded":
      return "warning";
    case "unsupported":
      return "critical";
  }
}

export function backendStatusLabel(status: BackendCapabilityStatus): string {
  switch (status) {
    case "supported":
      return "Supported";
    case "experimental":
      return "Experimental";
    case "degraded":
      return "Degraded";
    case "unsupported":
      return "Unsupported";
  }
}

function cellByDimension(
  summary: BackendCapabilitySummary,
  dimensionId: string,
): BackendCapabilityCell | undefined {
  return summary.cells.find((cell) => cell.dimensionId === dimensionId);
}

/** A stable, human-facing reason that blocks confirming a backend selection. */
export interface BackendSelectionBlocker {
  code: string;
  dimensionId?: string;
  message: string;
}

export interface BackendSelectionEvaluation {
  /**
   * `false` when the backend is unsupported, declares an unsupported capability,
   * or has an error-severity validation issue. Confirmation must be prevented.
   */
  canConfirm: boolean;
  blockers: readonly BackendSelectionBlocker[];
  warnings: readonly BackendSelectionBlocker[];
}

/**
 * Pure, server-safe evaluation of whether a backend selection may be confirmed.
 * Never mutates its inputs and never throws for well-formed view models.
 */
export function evaluateBackendSelection(
  summary: BackendCapabilitySummary,
  issues: readonly BackendSelectionIssue[] = [],
): BackendSelectionEvaluation {
  const blockers: BackendSelectionBlocker[] = [];
  const warnings: BackendSelectionBlocker[] = [];

  if (summary.status === "unsupported") {
    blockers.push({ code: summary.reasonCode, message: summary.reason });
  } else if (summary.status !== "supported") {
    warnings.push({ code: summary.reasonCode, message: summary.reason });
  }

  for (const cell of summary.cells) {
    if (cell.status === "unsupported") {
      blockers.push({
        code: cell.reasonCode,
        dimensionId: cell.dimensionId,
        message: cell.reason,
      });
    } else if (cell.status === "degraded") {
      warnings.push({
        code: cell.reasonCode,
        dimensionId: cell.dimensionId,
        message: cell.reason,
      });
    }
  }

  for (const issue of issues) {
    const blocker: BackendSelectionBlocker = {
      code: issue.code,
      message: issue.message,
      ...(issue.dimensionId === undefined
        ? {}
        : { dimensionId: issue.dimensionId }),
    };
    if (issue.severity === "error") {
      blockers.push(blocker);
    } else {
      warnings.push(blocker);
    }
  }

  return {
    blockers: Object.freeze(blockers),
    canConfirm: blockers.length === 0,
    warnings: Object.freeze(warnings),
  };
}

function StatusChip({ status }: { status: BackendCapabilityStatus }) {
  return (
    <Badge tone={backendStatusTone(status)}>{backendStatusLabel(status)}</Badge>
  );
}

export interface BackendCapabilityMatrixProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  backends: readonly BackendCapabilitySummary[];
  caption?: ReactNode;
  description?: ReactNode;
  dimensions?: readonly BackendCapabilityDimension[];
  emptyMessage?: ReactNode;
  heading?: ReactNode;
  headingLevel?: 2 | 3 | 4;
}

/**
 * Server-safe comparison matrix. Renders one column per backend and one row per
 * capability dimension, showing declared status, a bounded value, and the
 * stable reason so an operator can see every tradeoff before choosing.
 */
export function BackendCapabilityMatrix({
  backends,
  caption = "Backend capability comparison",
  className,
  description,
  dimensions = BACKEND_CAPABILITY_DIMENSIONS,
  emptyMessage = "No delivery backends are available to compare.",
  heading = "Backend capabilities",
  headingLevel = 2,
  ...props
}: BackendCapabilityMatrixProps) {
  const Heading = `h${headingLevel}` as const;
  const captionLabel =
    typeof caption === "string"
      ? `${caption} table`
      : "Backend capability table";

  return (
    <section {...props} className={classNames("whp-backend-matrix", className)}>
      <header className="whp-section-header">
        <div>
          <p className="whp-eyebrow">Delivery backend</p>
          <Heading>{heading}</Heading>
        </div>
        {description === undefined ? null : <div>{description}</div>}
      </header>
      {backends.length === 0 ? (
        <p className="whp-empty-inline">{emptyMessage}</p>
      ) : (
        <div
          aria-label={captionLabel}
          className="whp-table-scroll"
          role="region"
          tabIndex={0}
        >
          <table className="whp-backend-table">
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Capability</th>
                {backends.map((backend) => (
                  <th key={backend.id} scope="col">
                    <span className="whp-backend-table__name">
                      {backend.name}
                      {backend.recommended === true ? (
                        <span className="whp-table-note">Recommended</span>
                      ) : null}
                    </span>
                    <StatusChip status={backend.status} />
                    {backend.summary === undefined ? null : (
                      <span className="whp-backend-table__summary">
                        {backend.summary}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Overall</th>
                {backends.map((backend) => (
                  <td key={backend.id} data-status={backend.status}>
                    <StatusChip status={backend.status} />
                    <span className="whp-backend-cell__reason">
                      {backend.reason}
                    </span>
                  </td>
                ))}
              </tr>
              {dimensions.map((dimension) => (
                <tr key={dimension.id}>
                  <th scope="row">
                    <span className="whp-backend-table__dimension">
                      {dimension.label}
                    </span>
                    {dimension.description === undefined ? null : (
                      <span className="whp-backend-table__dimension-hint">
                        {dimension.description}
                      </span>
                    )}
                  </th>
                  {backends.map((backend) => {
                    const cell = cellByDimension(backend, dimension.id);
                    if (cell === undefined) {
                      return (
                        <td data-status="unknown" key={backend.id}>
                          <span className="whp-backend-cell__value">
                            Not declared
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td data-status={cell.status} key={backend.id}>
                        <StatusChip status={cell.status} />
                        <span className="whp-backend-cell__value">
                          {cell.value}
                        </span>
                        <span className="whp-backend-cell__reason">
                          {cell.reason}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export interface BackendSelectionReviewProps extends Omit<
  FormHTMLAttributes<HTMLFormElement>,
  "children" | "onSubmit"
> {
  actions?: ReactNode;
  confirmLabel?: ReactNode;
  confirmName?: string;
  confirmValue?: string;
  description?: ReactNode;
  dimensions?: readonly BackendCapabilityDimension[];
  headingLevel?: 2 | 3 | 4;
  issues?: readonly BackendSelectionIssue[];
  selection: BackendCapabilitySummary;
}

/**
 * Server-safe review of a single chosen backend. Renders the full tradeoff
 * detail and a confirm control that is disabled whenever the selection is
 * unsupported, declares an unsupported capability, or has an error-severity
 * issue. The blocking reasons are announced through a live alert region.
 */
export function BackendSelectionReview({
  actions,
  className,
  confirmLabel = "Confirm backend",
  confirmName = "backend",
  confirmValue,
  description,
  dimensions = BACKEND_CAPABILITY_DIMENSIONS,
  headingLevel = 2,
  issues = [],
  selection,
  ...props
}: BackendSelectionReviewProps) {
  const Heading = `h${headingLevel}` as const;
  const baseId = useId();
  const summaryId = `${baseId}-summary`;
  const headingId = `${baseId}-heading`;
  const blockersId = `${baseId}-blockers`;
  const { blockers, canConfirm, warnings } = evaluateBackendSelection(
    selection,
    issues,
  );
  const dimensionLabel = (dimensionId?: string): string | undefined =>
    dimensionId === undefined
      ? undefined
      : dimensions.find((dimension) => dimension.id === dimensionId)?.label;

  return (
    <form
      {...props}
      aria-describedby={summaryId}
      aria-labelledby={headingId}
      className={classNames("whp-backend-review", className)}
      data-can-confirm={canConfirm ? "true" : "false"}
    >
      <header className="whp-backend-review__header">
        <div>
          <p className="whp-eyebrow">Backend selection</p>
          <Heading id={headingId}>{selection.name}</Heading>
        </div>
        <StatusChip status={selection.status} />
      </header>
      <p className="whp-backend-review__summary" id={summaryId}>
        <span className="whp-visually-hidden">
          Selection status: {backendStatusLabel(selection.status)}.{" "}
        </span>
        {description ?? selection.summary ?? selection.reason}
      </p>

      {(selection.externalServices !== undefined &&
        selection.externalServices.length > 0) ||
      (selection.deploymentModes !== undefined &&
        selection.deploymentModes.length > 0) ? (
        <dl className="whp-backend-review__facts">
          {selection.externalServices === undefined ||
          selection.externalServices.length === 0 ? null : (
            <div>
              <dt>Required external services</dt>
              <dd>{selection.externalServices.join(", ")}</dd>
            </div>
          )}
          {selection.deploymentModes === undefined ||
          selection.deploymentModes.length === 0 ? null : (
            <div>
              <dt>Deployment modes</dt>
              <dd>{selection.deploymentModes.join(", ")}</dd>
            </div>
          )}
        </dl>
      ) : null}

      <ul className="whp-backend-review__tradeoffs">
        {dimensions.map((dimension) => {
          const cell = cellByDimension(selection, dimension.id);
          return (
            <li data-status={cell?.status ?? "unknown"} key={dimension.id}>
              <div className="whp-backend-review__tradeoff-head">
                <span className="whp-backend-review__tradeoff-label">
                  {dimension.label}
                </span>
                {cell === undefined ? (
                  <Badge tone="neutral">Not declared</Badge>
                ) : (
                  <StatusChip status={cell.status} />
                )}
              </div>
              <p className="whp-backend-review__tradeoff-value">
                {cell?.value ?? "The backend does not declare this capability."}
              </p>
              {cell === undefined ? null : (
                <p className="whp-backend-review__tradeoff-reason">
                  <code translate="no">{cell.reasonCode}</code> {cell.reason}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {warnings.length === 0 ? null : (
        <div
          className="whp-backend-review__notice"
          data-tone="warning"
          role="status"
        >
          <p className="whp-eyebrow">Review before confirming</p>
          <ul>
            {warnings.map((warning) => (
              <li key={`${warning.code}:${warning.dimensionId ?? ""}`}>
                {dimensionLabel(warning.dimensionId) === undefined ? null : (
                  <strong>{dimensionLabel(warning.dimensionId)}: </strong>
                )}
                <code translate="no">{warning.code}</code> {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        aria-live="polite"
        className="whp-backend-review__notice"
        data-tone="critical"
        hidden={canConfirm}
        id={blockersId}
        role="alert"
      >
        {canConfirm ? null : (
          <>
            <p className="whp-eyebrow">Cannot confirm this backend</p>
            <ul>
              {blockers.map((blocker) => (
                <li key={`${blocker.code}:${blocker.dimensionId ?? ""}`}>
                  {dimensionLabel(blocker.dimensionId) === undefined ? null : (
                    <strong>{dimensionLabel(blocker.dimensionId)}: </strong>
                  )}
                  <code translate="no">{blocker.code}</code> {blocker.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <footer className="whp-backend-review__actions">
        {actions}
        <button
          aria-describedby={canConfirm ? undefined : blockersId}
          className="whp-button"
          data-tone="primary"
          disabled={!canConfirm}
          name={confirmName}
          type="submit"
          value={confirmValue ?? selection.id}
        >
          {confirmLabel}
        </button>
      </footer>
    </form>
  );
}
