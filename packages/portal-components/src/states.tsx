// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from "react";

import { classNames } from "./internal.js";
import { Badge, Disclosure } from "./primitives.js";

export type StateHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

type StateHeadingTag = `h${StateHeadingLevel}`;

function stateHeadingTag(level: StateHeadingLevel): StateHeadingTag {
  return `h${level}`;
}

export interface StatePanelProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "title"
> {
  actions?: ReactNode;
  children?: ReactNode;
  eyebrow?: ReactNode;
  headingLevel?: StateHeadingLevel;
  icon?: ReactNode;
  title: ReactNode;
  tone?: "critical" | "neutral" | "positive" | "warning";
}

export function StatePanel({
  actions,
  children,
  className,
  eyebrow,
  headingLevel = 2,
  icon,
  title,
  tone = "neutral",
  ...props
}: StatePanelProps) {
  const Heading = stateHeadingTag(headingLevel);

  return (
    <section
      {...props}
      className={classNames("whp-state", className)}
      data-tone={tone}
    >
      {icon === undefined ? (
        <span aria-hidden="true" className="whp-state__glyph" />
      ) : (
        icon
      )}
      <div className="whp-state__copy">
        {eyebrow === undefined ? null : (
          <p className="whp-eyebrow">{eyebrow}</p>
        )}
        <Heading>{title}</Heading>
        {children === undefined ? null : (
          <div className="whp-state__description">{children}</div>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="whp-state__actions">{actions}</div>
      )}
    </section>
  );
}

export interface EmptyStateProps extends Omit<
  StatePanelProps,
  "eyebrow" | "tone"
> {
  eyebrow?: ReactNode;
}

export function EmptyState({
  eyebrow = "Nothing here yet",
  ...props
}: EmptyStateProps) {
  return <StatePanel {...props} eyebrow={eyebrow} tone="neutral" />;
}

export interface LoadingStateProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  label?: string;
  lines?: number;
}

export function LoadingState({
  className,
  label = "Loading portal content",
  lines = 3,
  ...props
}: LoadingStateProps) {
  return (
    <div
      {...props}
      aria-busy="true"
      className={classNames("whp-skeleton", className)}
      role="status"
    >
      <span className="whp-visually-hidden">{label}</span>
      <span aria-hidden="true" className="whp-skeleton__heading" />
      {Array.from({ length: Math.max(0, lines) }, (_, index) => (
        <span aria-hidden="true" className="whp-skeleton__line" key={index} />
      ))}
    </div>
  );
}

export interface IssueStateProps extends Omit<
  StatePanelProps,
  "children" | "title" | "tone"
> {
  children?: ReactNode;
  details?: ReactNode;
  title?: ReactNode;
}

export function IssueState({
  children = "The portal could not complete this request. Try again or contact support if the issue persists.",
  details,
  title = "Something needs attention",
  ...props
}: IssueStateProps) {
  return (
    <StatePanel {...props} role="alert" title={title} tone="critical">
      {children}
      {details === undefined ? null : (
        <Disclosure summary="Technical details">{details}</Disclosure>
      )}
    </StatePanel>
  );
}

export interface UnsupportedCapabilityProps extends Omit<
  StatePanelProps,
  "children" | "eyebrow" | "title" | "tone"
> {
  capability?: ReactNode;
  children?: ReactNode;
  title?: ReactNode;
}

export function UnsupportedCapability({
  capability,
  children = "This provider does not expose the operation for the current connection.",
  title = "Capability unavailable",
  ...props
}: UnsupportedCapabilityProps) {
  return (
    <StatePanel
      {...props}
      eyebrow="Provider capability"
      title={title}
      tone="warning"
    >
      {capability === undefined ? null : (
        <p>
          Requested capability: <strong>{capability}</strong>
        </p>
      )}
      {children}
    </StatePanel>
  );
}

export type DeletionStatus =
  "cancelled" | "deleted" | "deleting" | "failed" | "scheduled" | "unknown";

export interface DeletionStateProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  actions?: ReactNode;
  description?: ReactNode;
  effectiveAt?: string;
  effectiveAtLabel?: ReactNode;
  effectiveAtPrefix?: ReactNode;
  headingLevel?: StateHeadingLevel;
  operationId?: ReactNode;
  resourceName?: ReactNode;
  status: DeletionStatus;
}

function deletionCopy(status: DeletionStatus): {
  label: string;
  title: string;
  tone: "critical" | "neutral" | "positive" | "warning";
} {
  switch (status) {
    case "unknown":
      return {
        label: "Unknown",
        title: "Deletion status unavailable",
        tone: "neutral",
      };
    case "scheduled":
      return {
        label: "Scheduled",
        title: "Deletion is scheduled",
        tone: "warning",
      };
    case "deleting":
      return {
        label: "In progress",
        title: "Deletion is in progress",
        tone: "warning",
      };
    case "deleted":
      return {
        label: "Deleted",
        title: "Deletion complete",
        tone: "positive",
      };
    case "failed":
      return {
        label: "Failed",
        title: "Deletion could not complete",
        tone: "critical",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        title: "Deletion was cancelled",
        tone: "warning",
      };
  }
}

export function DeletionState({
  actions,
  className,
  description,
  effectiveAt,
  effectiveAtLabel,
  effectiveAtPrefix = "Effective",
  headingLevel = 2,
  operationId,
  resourceName,
  status,
  ...props
}: DeletionStateProps) {
  const copy = deletionCopy(status);
  const Heading = stateHeadingTag(headingLevel);

  return (
    <section
      {...props}
      className={classNames("whp-process-state", className)}
      data-tone={copy.tone}
      role={status === "failed" ? "alert" : "status"}
    >
      <header>
        <div>
          <p className="whp-eyebrow">Destructive operation</p>
          <Heading>{copy.title}</Heading>
        </div>
        <Badge tone={copy.tone}>{copy.label}</Badge>
      </header>
      {operationId === undefined ? null : (
        <p>
          Operation: <code translate="no">{operationId}</code>
        </p>
      )}
      {resourceName === undefined ? null : (
        <p>
          Resource: <strong>{resourceName}</strong>
        </p>
      )}
      {description === undefined ? null : <div>{description}</div>}
      {effectiveAt === undefined ? null : (
        <p>
          {effectiveAtPrefix}{" "}
          <time dateTime={effectiveAt}>{effectiveAtLabel ?? effectiveAt}</time>
        </p>
      )}
      {actions === undefined ? null : <footer>{actions}</footer>}
    </section>
  );
}

export type ExportStatus =
  | "cancelled"
  | "expired"
  | "failed"
  | "idle"
  | "preparing"
  | "ready"
  | "unknown";

export interface ExportStateProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "title"
> {
  actions?: ReactNode;
  description?: ReactNode;
  expiresAt?: string;
  expiresAtLabel?: ReactNode;
  headingLevel?: StateHeadingLevel;
  operationId?: ReactNode;
  progress?: number;
  status: ExportStatus;
  title?: ReactNode;
}

function exportCopy(status: ExportStatus): {
  label: string;
  title: string;
  tone: "critical" | "neutral" | "positive" | "warning";
} {
  switch (status) {
    case "unknown":
      return {
        label: "Unknown",
        title: "Export status unavailable",
        tone: "neutral",
      };
    case "idle":
      return {
        label: "Not started",
        title: "Export portal data",
        tone: "neutral",
      };
    case "preparing":
      return {
        label: "Preparing",
        title: "Preparing your export",
        tone: "warning",
      };
    case "ready":
      return {
        label: "Ready",
        title: "Export ready to download",
        tone: "positive",
      };
    case "expired":
      return {
        label: "Expired",
        title: "Export link expired",
        tone: "warning",
      };
    case "failed":
      return {
        label: "Failed",
        title: "Export could not complete",
        tone: "critical",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        title: "Export was cancelled",
        tone: "warning",
      };
  }
}

export function ExportState({
  actions,
  className,
  description,
  expiresAt,
  expiresAtLabel,
  headingLevel = 2,
  operationId,
  progress,
  status,
  title,
  ...props
}: ExportStateProps) {
  const copy = exportCopy(status);
  const Heading = stateHeadingTag(headingLevel);
  const boundedProgress =
    progress === undefined ? undefined : Math.min(100, Math.max(0, progress));

  return (
    <section
      {...props}
      className={classNames("whp-process-state", className)}
      data-tone={copy.tone}
      role={status === "failed" ? "alert" : "status"}
    >
      <header>
        <div>
          <p className="whp-eyebrow">Portable data</p>
          <Heading>{title ?? copy.title}</Heading>
        </div>
        <Badge tone={copy.tone}>{copy.label}</Badge>
      </header>
      {operationId === undefined ? null : (
        <p>
          Operation: <code translate="no">{operationId}</code>
        </p>
      )}
      {description === undefined ? null : <div>{description}</div>}
      {boundedProgress === undefined ? null : (
        <label className="whp-progress">
          <span>Export progress: {boundedProgress}%</span>
          <progress max={100} value={boundedProgress} />
        </label>
      )}
      {expiresAt === undefined ? null : (
        <p>
          Available until{" "}
          <time dateTime={expiresAt}>{expiresAtLabel ?? expiresAt}</time>
        </p>
      )}
      {actions === undefined ? null : <footer>{actions}</footer>}
    </section>
  );
}
