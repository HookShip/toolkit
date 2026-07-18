// SPDX-License-Identifier: Apache-2.0

import type { FormHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { classNames } from "./internal.js";
import { Badge, LatencyBadge } from "./primitives.js";
import type { DeliveryAttempt, DeliveryStatus } from "./types.js";

const DELIVERY_STATUS_OPTIONS: ReadonlyArray<{
  label: string;
  value: DeliveryStatus;
}> = [
  { label: "Queued", value: "queued" },
  { label: "Pending", value: "pending" },
  { label: "Retrying", value: "retrying" },
  { label: "Delivered", value: "delivered" },
  { label: "Failed", value: "failed" },
  { label: "Canceled", value: "canceled" },
];

function deliveryStatusTone(
  status: DeliveryStatus,
): "critical" | "neutral" | "positive" | "warning" {
  switch (status) {
    case "delivered":
      return "positive";
    case "failed":
      return "critical";
    case "pending":
    case "queued":
    case "retrying":
      return "warning";
    case "canceled":
      return "neutral";
  }
}

function deliveryStatusLabel(status: DeliveryStatus): string {
  const option = DELIVERY_STATUS_OPTIONS.find((item) => item.value === status);
  return option?.label ?? status;
}

export interface DeliveryStatusBadgeProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
> {
  status: DeliveryStatus;
}

export function DeliveryStatusBadge({
  status,
  ...props
}: DeliveryStatusBadgeProps) {
  return (
    <Badge {...props} tone={deliveryStatusTone(status)}>
      {deliveryStatusLabel(status)}
    </Badge>
  );
}

export interface DeliveryTimelineProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  attempts: readonly DeliveryAttempt[];
  description?: ReactNode;
  empty?: ReactNode;
  heading?: ReactNode;
  renderAttempt?: (attempt: DeliveryAttempt) => ReactNode;
}

export function DeliveryTimeline({
  attempts,
  className,
  description,
  empty,
  heading = "Delivery timeline",
  renderAttempt,
  ...props
}: DeliveryTimelineProps) {
  return (
    <section {...props} className={classNames("whp-deliveries", className)}>
      <header className="whp-section-header">
        <div>
          <p className="whp-eyebrow">Attempt ledger</p>
          <h2>{heading}</h2>
        </div>
        {description === undefined ? null : <div>{description}</div>}
      </header>
      {attempts.length === 0 ? (
        (empty ?? <p className="whp-empty-inline">No delivery attempts yet.</p>)
      ) : (
        <ol className="whp-timeline">
          {attempts.map((attempt) => (
            <li key={attempt.id}>
              {renderAttempt === undefined ? (
                <AttemptRow attempt={attempt} />
              ) : (
                renderAttempt(attempt)
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export interface AttemptRowProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  attempt: DeliveryAttempt;
}

export function AttemptRow({ attempt, className, ...props }: AttemptRowProps) {
  return (
    <article {...props} className={classNames("whp-attempt", className)}>
      <div aria-hidden="true" className="whp-attempt__rail">
        <span />
      </div>
      <div className="whp-attempt__header">
        <div>
          <span className="whp-attempt__number">Attempt {attempt.attempt}</span>
          <time dateTime={attempt.occurredAt}>{attempt.occurredAtLabel}</time>
        </div>
        <div className="whp-attempt__badges">
          <DeliveryStatusBadge status={attempt.status} />
          {attempt.latencyMs === undefined ? null : (
            <LatencyBadge milliseconds={attempt.latencyMs} />
          )}
        </div>
      </div>
      <dl className="whp-attempt__facts">
        {attempt.endpoint === undefined ? null : (
          <div>
            <dt>Endpoint</dt>
            <dd>
              <code>{attempt.endpoint}</code>
            </dd>
          </div>
        )}
        {attempt.responseCode === undefined ? null : (
          <div>
            <dt>HTTP response</dt>
            <dd>{attempt.responseCode}</dd>
          </div>
        )}
        {attempt.completedAt === undefined ? null : (
          <div>
            <dt>Completed</dt>
            <dd>
              <time dateTime={attempt.completedAt}>
                {attempt.completedAtLabel ?? attempt.completedAt}
              </time>
            </dd>
          </div>
        )}
      </dl>
      {attempt.message === undefined ? null : (
        <div className="whp-attempt__message">{attempt.message}</div>
      )}
      {attempt.actions === undefined ? null : (
        <footer className="whp-attempt__actions">{attempt.actions}</footer>
      )}
    </article>
  );
}

export interface DeliveryFilterEndpoint {
  label: string;
  value: string;
}

export interface DeliveryFiltersProps extends Omit<
  FormHTMLAttributes<HTMLFormElement>,
  "children" | "onChange"
> {
  defaultEndpoint?: string;
  defaultQuery?: string;
  defaultStatus?: DeliveryStatus | "all";
  endpoints?: readonly DeliveryFilterEndpoint[];
  idPrefix?: string;
  submitLabel?: string;
}

export function DeliveryFilters({
  className,
  defaultEndpoint = "all",
  defaultQuery = "",
  defaultStatus = "all",
  endpoints = [],
  idPrefix = "delivery-filters",
  submitLabel = "Apply filters",
  ...props
}: DeliveryFiltersProps) {
  return (
    <form
      {...props}
      autoComplete="off"
      className={classNames("whp-filters", className)}
      role="search"
    >
      <div className="whp-filter-field whp-filter-field--search">
        <label htmlFor={`${idPrefix}-query`}>Search deliveries</label>
        <input
          autoComplete="off"
          defaultValue={defaultQuery}
          id={`${idPrefix}-query`}
          inputMode="search"
          name="query"
          placeholder="e.g. order.created, Orders EU, or evt_01J2…"
          spellCheck={false}
          type="search"
        />
      </div>
      <div className="whp-filter-field">
        <label htmlFor={`${idPrefix}-status`}>Status</label>
        <select
          autoComplete="off"
          defaultValue={defaultStatus}
          id={`${idPrefix}-status`}
          name="status"
        >
          <option value="all">All statuses</option>
          {DELIVERY_STATUS_OPTIONS.map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
      </div>
      {endpoints.length === 0 ? null : (
        <div className="whp-filter-field">
          <label htmlFor={`${idPrefix}-endpoint`}>Endpoint</label>
          <select
            autoComplete="off"
            defaultValue={defaultEndpoint}
            id={`${idPrefix}-endpoint`}
            name="endpoint"
          >
            <option value="all">All endpoints</option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.value} value={endpoint.value}>
                {endpoint.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <button className="whp-button" data-tone="primary" type="submit">
        {submitLabel}
      </button>
    </form>
  );
}

export interface DeliveryActionProps extends Omit<
  FormHTMLAttributes<HTMLFormElement>,
  "action" | "children" | "method"
> {
  action: FormHTMLAttributes<HTMLFormElement>["action"];
  disabledReason?: ReactNode;
  hiddenFields?: Readonly<Record<string, string>>;
  label: ReactNode;
  method?: "get" | "post";
  tone?: "critical" | "primary" | "quiet";
}

export function DeliveryAction({
  action,
  className,
  disabledReason,
  hiddenFields,
  label,
  method = "post",
  tone = "quiet",
  ...props
}: DeliveryActionProps) {
  const unavailable = disabledReason !== undefined;

  return (
    <form
      {...props}
      action={unavailable ? undefined : action}
      autoComplete="off"
      className={classNames("whp-action-form", className)}
      method={method}
    >
      {hiddenFields === undefined
        ? null
        : Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} name={name} type="hidden" value={value} />
          ))}
      <button
        aria-disabled={unavailable ? true : undefined}
        className="whp-button"
        data-tone={tone}
        type={unavailable ? "button" : "submit"}
      >
        {label}
      </button>
      {disabledReason === undefined ? null : (
        <span className="whp-action-form__reason">{disabledReason}</span>
      )}
    </form>
  );
}

export type NamedDeliveryActionProps = Omit<DeliveryActionProps, "label"> & {
  label?: ReactNode;
};

export function ReplayDeliveryAction({
  label = "Replay delivery",
  ...props
}: NamedDeliveryActionProps) {
  return <DeliveryAction {...props} label={label} />;
}

export function TestEndpointAction({
  label = "Send test event",
  ...props
}: NamedDeliveryActionProps) {
  return <DeliveryAction {...props} label={label} />;
}
