// SPDX-License-Identifier: Apache-2.0

import {
  useId,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

import { classNames, descriptionIds } from "./internal.js";
import { Badge } from "./primitives.js";
import type { EndpointStatus, EndpointSummary } from "./types.js";

function endpointStatusTone(
  status: EndpointStatus,
): "critical" | "neutral" | "positive" | "warning" {
  switch (status) {
    case "active":
      return "positive";
    case "failing":
      return "critical";
    case "pending":
      return "warning";
    case "disabled":
    case "paused":
      return "neutral";
  }
}

function endpointStatusLabel(status: EndpointStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "disabled":
      return "Disabled";
    case "failing":
      return "Failing";
    case "paused":
      return "Paused";
    case "pending":
      return "Pending verification";
  }
}

export interface EndpointListProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  description?: ReactNode;
  empty?: ReactNode;
  endpoints: readonly EndpointSummary[];
  heading?: ReactNode;
  renderEndpoint?: (endpoint: EndpointSummary) => ReactNode;
}

export function EndpointList({
  className,
  description,
  empty,
  endpoints,
  heading = "Endpoints",
  renderEndpoint,
  ...props
}: EndpointListProps) {
  return (
    <section {...props} className={classNames("whp-endpoints", className)}>
      <header className="whp-section-header">
        <div>
          <p className="whp-eyebrow">Delivery surface</p>
          <h2>{heading}</h2>
        </div>
        {description === undefined ? null : <div>{description}</div>}
      </header>
      {endpoints.length === 0 ? (
        (empty ?? <p className="whp-empty-inline">No endpoints configured.</p>)
      ) : (
        <ul className="whp-endpoint-list">
          {endpoints.map((endpoint) => (
            <li key={endpoint.id}>
              {renderEndpoint === undefined ? (
                <EndpointCard endpoint={endpoint} />
              ) : (
                renderEndpoint(endpoint)
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface EndpointCardProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  actions?: ReactNode;
  endpoint: EndpointSummary;
}

export function EndpointCard({
  actions,
  className,
  endpoint,
  ...props
}: EndpointCardProps) {
  const heading =
    endpoint.href === undefined ? (
      endpoint.name
    ) : (
      <a href={endpoint.href}>{endpoint.name}</a>
    );

  return (
    <article {...props} className={classNames("whp-endpoint-card", className)}>
      <div className="whp-endpoint-card__status">
        <Badge tone={endpointStatusTone(endpoint.status)}>
          {endpointStatusLabel(endpoint.status)}
        </Badge>
      </div>
      <div className="whp-endpoint-card__body">
        <h3>{heading}</h3>
        <code className="whp-endpoint-card__url">{endpoint.url}</code>
        {endpoint.description === undefined ? null : (
          <div className="whp-endpoint-card__description">
            {endpoint.description}
          </div>
        )}
        <dl className="whp-inline-facts">
          {endpoint.eventCount === undefined ? null : (
            <div>
              <dt>Subscriptions</dt>
              <dd>{endpoint.eventCount}</dd>
            </div>
          )}
          {endpoint.updatedAt === undefined ? null : (
            <div>
              <dt>Updated</dt>
              <dd>
                <time dateTime={endpoint.updatedAt}>
                  {endpoint.updatedAtLabel ?? endpoint.updatedAt}
                </time>
              </dd>
            </div>
          )}
        </dl>
      </div>
      {actions === undefined ? null : (
        <div className="whp-endpoint-card__actions">{actions}</div>
      )}
    </article>
  );
}

export interface EndpointFormProps extends Omit<
  FormHTMLAttributes<HTMLFormElement>,
  "children" | "title"
> {
  actions?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  title?: ReactNode;
}

export function EndpointForm({
  actions,
  children,
  className,
  description,
  title,
  ...props
}: EndpointFormProps) {
  return (
    <form {...props} className={classNames("whp-form", className)}>
      {title === undefined && description === undefined ? null : (
        <header className="whp-form__header">
          {title === undefined ? null : <h2>{title}</h2>}
          {description === undefined ? null : <div>{description}</div>}
        </header>
      )}
      <div className="whp-form__fields">{children}</div>
      {actions === undefined ? null : (
        <footer className="whp-form__actions">{actions}</footer>
      )}
    </form>
  );
}

export interface EndpointFieldProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  children: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  htmlFor: string;
  label: ReactNode;
  required?: boolean;
}

export function EndpointField({
  children,
  className,
  error,
  hint,
  htmlFor,
  label,
  required = false,
  ...props
}: EndpointFieldProps) {
  return (
    <div {...props} className={classNames("whp-field", className)}>
      <div className="whp-field__label-row">
        <label htmlFor={htmlFor}>{label}</label>
        <span>{required ? "Required" : "Optional"}</span>
      </div>
      {hint === undefined ? null : (
        <div className="whp-field__hint" id={`${htmlFor}-hint`}>
          {hint}
        </div>
      )}
      {children}
      {error === undefined ? null : (
        <div className="whp-field__error" id={`${htmlFor}-error`}>
          <strong>Issue:</strong> {error}
        </div>
      )}
    </div>
  );
}

export interface EndpointInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "children"
> {
  error?: ReactNode;
  hint?: ReactNode;
  id: string;
  label: ReactNode;
}

export function EndpointInput({
  "aria-describedby": ariaDescribedBy,
  autoComplete = "off",
  className,
  error,
  hint,
  id,
  label,
  required,
  ...props
}: EndpointInputProps) {
  return (
    <EndpointField
      error={error}
      hint={hint}
      htmlFor={id}
      label={label}
      required={required === true}
    >
      <input
        {...props}
        aria-describedby={descriptionIds(
          ariaDescribedBy,
          hint === undefined ? null : `${id}-hint`,
          error === undefined ? null : `${id}-error`,
        )}
        aria-invalid={error === undefined ? undefined : true}
        autoComplete={autoComplete}
        className={classNames("whp-input", className)}
        id={id}
        required={required}
      />
    </EndpointField>
  );
}

export interface SelectOption {
  disabled?: boolean;
  label: string;
  value: string;
}

export interface EndpointSelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "children"
> {
  error?: ReactNode;
  hint?: ReactNode;
  id: string;
  label: ReactNode;
  options: readonly SelectOption[];
}

export function EndpointSelect({
  "aria-describedby": ariaDescribedBy,
  autoComplete = "off",
  className,
  error,
  hint,
  id,
  label,
  options,
  required,
  ...props
}: EndpointSelectProps) {
  return (
    <EndpointField
      error={error}
      hint={hint}
      htmlFor={id}
      label={label}
      required={required === true}
    >
      <select
        {...props}
        aria-describedby={descriptionIds(
          ariaDescribedBy,
          hint === undefined ? null : `${id}-hint`,
          error === undefined ? null : `${id}-error`,
        )}
        aria-invalid={error === undefined ? undefined : true}
        autoComplete={autoComplete}
        className={classNames("whp-select", className)}
        id={id}
        required={required}
      >
        {options.map((option) => (
          <option
            disabled={option.disabled}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
    </EndpointField>
  );
}

export interface SubscriptionEventOption {
  description?: ReactNode;
  disabled?: boolean;
  name: ReactNode;
  value: string;
  version?: string;
}

export interface SubscriptionEventSelectorProps extends Omit<
  HTMLAttributes<HTMLFieldSetElement>,
  "children"
> {
  description?: ReactNode;
  legend?: ReactNode;
  name?: string;
  options: readonly SubscriptionEventOption[];
  selected?: readonly string[];
}

export function SubscriptionEventSelector({
  "aria-describedby": ariaDescribedBy,
  className,
  description,
  legend = "Subscribed events",
  name = "events",
  options,
  selected = [],
  ...props
}: SubscriptionEventSelectorProps) {
  const generatedDescriptionId = useId();
  const descriptionId =
    description === undefined ? undefined : generatedDescriptionId;
  const selectedValues = new Set(selected);

  return (
    <fieldset
      {...props}
      aria-describedby={descriptionIds(ariaDescribedBy, descriptionId)}
      className={classNames("whp-event-selector", className)}
    >
      <legend>{legend}</legend>
      {description === undefined ? null : (
        <div className="whp-event-selector__description" id={descriptionId}>
          {description}
        </div>
      )}
      <ul>
        {options.map((option) => (
          <li key={option.value}>
            <label>
              <input
                autoComplete="off"
                defaultChecked={selectedValues.has(option.value)}
                disabled={option.disabled}
                name={name}
                type="checkbox"
                value={option.value}
              />
              <span className="whp-event-selector__copy">
                <span>
                  <strong>{option.name}</strong>
                  {option.version === undefined ? null : (
                    <code>v{option.version}</code>
                  )}
                </span>
                {option.description === undefined ? null : (
                  <small>{option.description}</small>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
