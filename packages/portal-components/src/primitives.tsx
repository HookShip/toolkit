// SPDX-License-Identifier: Apache-2.0

import type {
  ButtonHTMLAttributes,
  DetailsHTMLAttributes,
  DialogHTMLAttributes,
  HTMLAttributes,
  OlHTMLAttributes,
  Ref,
  ReactNode,
} from "react";

import { classNames } from "./internal.js";

export type PortalTone =
  "critical" | "info" | "neutral" | "positive" | "warning";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: PortalTone;
}

export function Badge({
  children,
  className,
  tone = "neutral",
  ...props
}: BadgeProps) {
  return (
    <span
      {...props}
      className={classNames("whp-badge", className)}
      data-tone={tone}
    >
      <span aria-hidden="true" className="whp-badge__signal" />
      <span>{children}</span>
    </span>
  );
}

export interface LatencyBadgeProps extends Omit<
  BadgeProps,
  "children" | "tone"
> {
  milliseconds: number;
  slowAfterMs?: number;
}

function formatLatency(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${Math.round(milliseconds)} ms`;
  }

  const seconds = milliseconds / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

export function LatencyBadge({
  milliseconds,
  slowAfterMs = 1_000,
  ...props
}: LatencyBadgeProps) {
  return (
    <Badge
      {...props}
      aria-label={`Latency ${formatLatency(milliseconds)}`}
      tone={milliseconds >= slowAfterMs ? "warning" : "neutral"}
    >
      {formatLatency(milliseconds)}
    </Badge>
  );
}

export interface DisclosureProps extends Omit<
  DetailsHTMLAttributes<HTMLDetailsElement>,
  "children"
> {
  children: ReactNode;
  summary: ReactNode;
}

export function Disclosure({
  children,
  className,
  summary,
  ...props
}: DisclosureProps) {
  return (
    <details {...props} className={classNames("whp-disclosure", className)}>
      <summary className="whp-disclosure__summary">{summary}</summary>
      <div className="whp-disclosure__content">{children}</div>
    </details>
  );
}

export interface LiveRegionProps extends HTMLAttributes<HTMLDivElement> {
  atomic?: boolean;
  politeness?: "assertive" | "off" | "polite";
  visuallyHidden?: boolean;
}

export function LiveRegion({
  atomic = true,
  className,
  politeness = "polite",
  visuallyHidden = true,
  ...props
}: LiveRegionProps) {
  return (
    <div
      {...props}
      aria-atomic={atomic}
      aria-live={politeness}
      className={classNames(
        "whp-live-region",
        visuallyHidden && "whp-visually-hidden",
        className,
      )}
    />
  );
}

export interface ToastRegionProps extends Omit<
  OlHTMLAttributes<HTMLOListElement>,
  "children"
> {
  children?: ReactNode;
  label?: string;
  politeness?: "assertive" | "polite";
}

/**
 * A presentation-only live region. Applications retain ownership of toast
 * state and can render list items without subscribing the whole portal tree.
 */
export function ToastRegion({
  children,
  className,
  label = "Notifications",
  politeness = "polite",
  ...props
}: ToastRegionProps) {
  return (
    <ol
      {...props}
      aria-label={label}
      aria-live={politeness}
      aria-relevant="additions text"
      className={classNames("whp-toast-region", className)}
    >
      {children}
    </ol>
  );
}

export interface PortalButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: "critical" | "primary" | "quiet";
}

export function PortalButton({
  className,
  tone = "quiet",
  type = "button",
  ...props
}: PortalButtonProps) {
  return (
    <button
      {...props}
      className={classNames("whp-button", className)}
      data-tone={tone}
      type={type}
    />
  );
}

export interface PortalDialogProps extends Omit<
  DialogHTMLAttributes<HTMLDialogElement>,
  "title"
> {
  children: ReactNode;
  description?: ReactNode;
  descriptionId?: string;
  dialogRef?: Ref<HTMLDialogElement>;
  footer?: ReactNode;
  title: ReactNode;
  titleId: string;
}

/**
 * A thin wrapper around the platform dialog element. Client owners can call
 * showModal()/close() on a ref without paying for a dialog framework.
 */
export function PortalDialog({
  "aria-describedby": ariaDescribedBy,
  "aria-labelledby": ariaLabelledBy,
  children,
  className,
  description,
  descriptionId,
  dialogRef,
  footer,
  open,
  title,
  titleId,
  ...props
}: PortalDialogProps) {
  const resolvedDescriptionId =
    description === undefined
      ? undefined
      : (descriptionId ?? `${titleId}-description`);

  return (
    <dialog
      {...props}
      aria-describedby={ariaDescribedBy ?? resolvedDescriptionId}
      aria-labelledby={ariaLabelledBy ?? titleId}
      className={classNames("whp-dialog", className)}
      open={open}
      ref={dialogRef}
    >
      <div className="whp-dialog__header">
        <h2 className="whp-dialog__title" id={titleId}>
          {title}
        </h2>
        {description === undefined ? null : (
          <div className="whp-dialog__description" id={resolvedDescriptionId}>
            {description}
          </div>
        )}
      </div>
      <div className="whp-dialog__body">{children}</div>
      {footer === undefined ? null : (
        <footer className="whp-dialog__footer">{footer}</footer>
      )}
    </dialog>
  );
}

export function VisuallyHidden({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...props} className={classNames("whp-visually-hidden", className)} />
  );
}
