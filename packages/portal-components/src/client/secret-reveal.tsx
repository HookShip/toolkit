"use client";

// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";

import { classNames } from "../internal.js";
import { CopyButton } from "./copy-button.js";

export interface SecretRevealProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  allowHide?: boolean;
  copyLabel?: string;
  initiallyRevealed?: boolean;
  label?: ReactNode;
  oneTime?: boolean;
  onDismiss?: () => void;
  redactedValue?: string;
  secret: string;
}

export function SecretReveal({
  allowHide = true,
  className,
  copyLabel = "Copy secret",
  initiallyRevealed = false,
  label = "Signing secret",
  oneTime = false,
  onDismiss,
  redactedValue = "•••• •••• •••• ••••",
  secret,
  ...props
}: SecretRevealProps) {
  const [revealed, setRevealed] = useState(initiallyRevealed);
  const [dismissed, setDismissed] = useState(false);
  const valueId = useId();
  const visible = revealed && !dismissed;

  return (
    <div {...props} className={classNames("whp-secret-reveal", className)}>
      {oneTime ? (
        <div className="whp-one-time-warning" role="alert">
          <strong>One-time reveal</strong>
          <span>
            Store this value securely. It will not be available again after you
            dismiss it or leave this page.
          </span>
        </div>
      ) : null}
      <span className="whp-secret__label">{label}</span>
      <div className="whp-secret-reveal__value">
        <code
          aria-label={visible ? "Secret value" : "Secret value is hidden"}
          id={valueId}
        >
          {visible ? secret : redactedValue}
        </code>
        <div className="whp-secret-reveal__actions">
          {visible ? <CopyButton label={copyLabel} value={secret} /> : null}
          {oneTime && visible ? (
            <button
              aria-controls={valueId}
              aria-expanded={visible}
              className="whp-button"
              data-tone="quiet"
              onClick={() => {
                setDismissed(true);
                setRevealed(false);
                onDismiss?.();
              }}
              type="button"
            >
              Dismiss and redact
            </button>
          ) : !dismissed && (!revealed || allowHide) ? (
            <button
              aria-controls={valueId}
              aria-expanded={visible}
              className="whp-button"
              data-tone="quiet"
              onClick={() => {
                setRevealed((current) => !current);
              }}
              type="button"
            >
              {visible ? "Hide secret" : "Reveal secret"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
