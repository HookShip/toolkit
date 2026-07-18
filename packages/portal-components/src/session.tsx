// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from "react";

import { classNames } from "./internal.js";

export interface DelegatedSessionExpiredProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "title"
> {
  actions?: ReactNode;
  description?: ReactNode;
  identity?: ReactNode;
  title?: ReactNode;
}

export function DelegatedSessionExpired({
  actions,
  className,
  description = "For your security, this delegated portal session has ended. Authenticate again to continue managing webhook resources.",
  identity,
  title = "Your portal session expired",
  ...props
}: DelegatedSessionExpiredProps) {
  return (
    <section
      {...props}
      className={classNames("whp-session-expired", className)}
      role="alert"
    >
      <div aria-hidden="true" className="whp-session-expired__clock">
        <span />
      </div>
      <div>
        <p className="whp-eyebrow">Delegated access</p>
        <h1>{title}</h1>
        <div className="whp-session-expired__description">{description}</div>
        {identity === undefined ? null : (
          <p className="whp-session-expired__identity">
            Previous session: <strong>{identity}</strong>
          </p>
        )}
        {actions === undefined ? null : (
          <div className="whp-session-expired__actions">{actions}</div>
        )}
      </div>
    </section>
  );
}
