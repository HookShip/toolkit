// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from "react";

import { classNames } from "./internal.js";
import { Badge } from "./primitives.js";
import type { SecretRotationStatus } from "./types.js";

export interface RedactedSecretProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  actions?: ReactNode;
  label?: ReactNode;
  redactedValue?: string;
}

export function RedactedSecret({
  actions,
  className,
  label = "Signing secret",
  redactedValue = "•••• •••• •••• ••••",
  ...props
}: RedactedSecretProps) {
  return (
    <div {...props} className={classNames("whp-secret", className)}>
      <div>
        <span className="whp-secret__label">{label}</span>
        <code aria-label="Secret value is hidden">{redactedValue}</code>
      </div>
      {actions === undefined ? null : (
        <div className="whp-secret__actions">{actions}</div>
      )}
    </div>
  );
}

export interface OneTimeRevealWarningProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function OneTimeRevealWarning({
  children = "This value is shown once. Store it in a secure secret manager before leaving this page.",
  className,
  ...props
}: OneTimeRevealWarningProps) {
  return (
    <div
      {...props}
      className={classNames("whp-one-time-warning", className)}
      role="alert"
    >
      <strong>One-time reveal</strong>
      <span>{children}</span>
    </div>
  );
}

function rotationTone(
  status: SecretRotationStatus,
): "critical" | "neutral" | "positive" | "warning" {
  switch (status) {
    case "stable":
      return "positive";
    case "pending":
    case "overlap":
      return "warning";
    case "failed":
      return "critical";
  }
}

function rotationLabel(status: SecretRotationStatus): string {
  switch (status) {
    case "stable":
      return "Stable";
    case "pending":
      return "Rotation pending";
    case "overlap":
      return "Overlap window active";
    case "failed":
      return "Rotation failed";
  }
}

export interface SecretRotationStateProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "title"
> {
  actions?: ReactNode;
  currentKey?: ReactNode;
  description?: ReactNode;
  nextChangeAt?: string;
  nextChangeAtLabel?: ReactNode;
  nextKey?: ReactNode;
  status: SecretRotationStatus;
  title?: ReactNode;
}

export function SecretRotationState({
  actions,
  className,
  currentKey,
  description,
  nextChangeAt,
  nextChangeAtLabel,
  nextKey,
  status,
  title = "Secret rotation",
  ...props
}: SecretRotationStateProps) {
  return (
    <section {...props} className={classNames("whp-rotation-state", className)}>
      <header>
        <div>
          <p className="whp-eyebrow">Credential lifecycle</p>
          <h3>{title}</h3>
        </div>
        <Badge tone={rotationTone(status)}>{rotationLabel(status)}</Badge>
      </header>
      {description === undefined ? null : <div>{description}</div>}
      <dl className="whp-definition-grid">
        {currentKey === undefined ? null : (
          <div>
            <dt>Current key</dt>
            <dd>{currentKey}</dd>
          </div>
        )}
        {nextKey === undefined ? null : (
          <div>
            <dt>Next key</dt>
            <dd>{nextKey}</dd>
          </div>
        )}
        {nextChangeAt === undefined ? null : (
          <div>
            <dt>Next transition</dt>
            <dd>
              <time dateTime={nextChangeAt}>
                {nextChangeAtLabel ?? nextChangeAt}
              </time>
            </dd>
          </div>
        )}
      </dl>
      {actions === undefined ? null : (
        <footer className="whp-rotation-state__actions">{actions}</footer>
      )}
    </section>
  );
}
