"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes } from "react";

import { classNames } from "../internal.js";

export interface CopyButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "value"
> {
  copiedLabel?: string;
  errorLabel?: string;
  label?: string;
  resetAfterMs?: number;
  value: string;
  writeText?: (value: string) => Promise<void> | void;
}

type CopyStatus = "copied" | "error" | "idle";

export function CopyButton({
  className,
  copiedLabel = "Copied",
  errorLabel = "Copy failed",
  label = "Copy",
  resetAfterMs = 2_000,
  value,
  writeText,
  ...props
}: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const statusId = useId();
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  async function copyValue() {
    try {
      if (writeText !== undefined) {
        await writeText(value);
      } else if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(value);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      setStatus("copied");
    } catch {
      setStatus("error");
    }

    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setStatus("idle");
    }, resetAfterMs);
  }

  const statusLabel =
    status === "copied" ? copiedLabel : status === "error" ? errorLabel : "";

  return (
    <>
      <button
        {...props}
        aria-describedby={statusId}
        className={classNames("whp-copy-button", className)}
        data-status={status}
        onClick={copyValue}
        type="button"
      >
        <span aria-hidden="true" className="whp-copy-button__glyph">
          <span />
          <span />
        </span>
        <span>{status === "copied" ? copiedLabel : label}</span>
      </button>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="whp-visually-hidden"
        id={statusId}
      >
        {statusLabel}
      </span>
    </>
  );
}
