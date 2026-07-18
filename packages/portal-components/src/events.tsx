// SPDX-License-Identifier: Apache-2.0

import type { FormHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { classNames } from "./internal.js";
import { Badge } from "./primitives.js";
import type { EventSummary, EventVersion, SchemaProperty } from "./types.js";

export interface EventCatalogProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  description?: ReactNode;
  empty?: ReactNode;
  events: readonly EventSummary[];
  heading?: ReactNode;
  renderEvent?: (event: EventSummary) => ReactNode;
}

export function EventCatalog({
  className,
  description,
  empty,
  events,
  heading = "Event catalog",
  renderEvent,
  ...props
}: EventCatalogProps) {
  return (
    <section {...props} className={classNames("whp-catalog", className)}>
      <header className="whp-section-header">
        <div>
          <p className="whp-eyebrow">Contract surface</p>
          <h2>{heading}</h2>
        </div>
        {description === undefined ? null : <div>{description}</div>}
      </header>
      {events.length === 0 ? (
        (empty ?? <p className="whp-empty-inline">No events are available.</p>)
      ) : (
        <ul className="whp-card-grid">
          {events.map((event) => (
            <li key={event.id}>
              {renderEvent === undefined ? (
                <EventCard event={event} />
              ) : (
                renderEvent(event)
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface EventCardProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  event: EventSummary;
  footer?: ReactNode;
}

export function EventCard({
  className,
  event,
  footer,
  ...props
}: EventCardProps) {
  return (
    <article {...props} className={classNames("whp-card", className)}>
      <div className="whp-card__index" aria-hidden="true">
        {event.id}
      </div>
      <div className="whp-card__meta">
        {event.category === undefined ? null : <span>{event.category}</span>}
        <code>v{event.version}</code>
      </div>
      <h3>
        <a href={event.href}>{event.name}</a>
      </h3>
      <div className="whp-card__description">{event.description}</div>
      {event.deprecated === true ? (
        <Badge tone="warning">Deprecated</Badge>
      ) : null}
      {footer === undefined ? null : (
        <footer className="whp-card__footer">{footer}</footer>
      )}
    </article>
  );
}

export interface EventDetailProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "title"
> {
  actions?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  eventName: ReactNode;
  eventType: string;
  metadata?: ReactNode;
  version?: string;
}

export function EventDetail({
  actions,
  children,
  className,
  description,
  eventName,
  eventType,
  metadata,
  version,
  ...props
}: EventDetailProps) {
  return (
    <article {...props} className={classNames("whp-event-detail", className)}>
      <header className="whp-event-detail__header">
        <div>
          <p className="whp-eyebrow">Event contract</p>
          <h1>{eventName}</h1>
          <code className="whp-event-detail__type">{eventType}</code>
        </div>
        <div className="whp-event-detail__tools">
          {version === undefined ? null : <Badge>Version {version}</Badge>}
          {actions}
        </div>
        {description === undefined ? null : (
          <div className="whp-event-detail__description">{description}</div>
        )}
        {metadata === undefined ? null : (
          <div className="whp-event-detail__metadata">{metadata}</div>
        )}
      </header>
      <div className="whp-event-detail__body">{children}</div>
    </article>
  );
}

export interface VersionSwitcherProps extends Omit<
  FormHTMLAttributes<HTMLFormElement>,
  "children" | "onChange"
> {
  current: string;
  hiddenFields?: Readonly<Record<string, string>>;
  id: string;
  label?: string;
  name?: string;
  submitLabel?: string;
  versions: readonly EventVersion[];
}

export function VersionSwitcher({
  className,
  current,
  hiddenFields,
  id,
  label = "Event version",
  name = "version",
  submitLabel = "View version",
  versions,
  ...props
}: VersionSwitcherProps) {
  return (
    <form
      {...props}
      autoComplete="off"
      className={classNames("whp-version-switcher", className)}
    >
      {hiddenFields === undefined
        ? null
        : Object.entries(hiddenFields).map(([fieldName, value]) => (
            <input
              key={fieldName}
              name={fieldName}
              type="hidden"
              value={value}
            />
          ))}
      <label htmlFor={id}>{label}</label>
      <div className="whp-control-row">
        <select autoComplete="off" defaultValue={current} id={id} name={name}>
          {versions.map((version) => (
            <option key={version.value} value={version.value}>
              {version.label ?? version.value}
              {version.deprecated === true ? " — deprecated" : ""}
            </option>
          ))}
        </select>
        <button className="whp-button" data-tone="quiet" type="submit">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export interface SchemaPropertyTableProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  caption?: ReactNode;
  emptyMessage?: ReactNode;
  properties: readonly SchemaProperty[];
}

export function SchemaPropertyTable({
  caption = "Payload properties",
  className,
  emptyMessage = "This schema has no declared properties.",
  properties,
  ...props
}: SchemaPropertyTableProps) {
  return (
    <div
      {...props}
      aria-label={
        typeof caption === "string"
          ? `${caption} table`
          : "Schema properties table"
      }
      className={classNames("whp-table-scroll", className)}
      role="region"
      tabIndex={0}
    >
      <table className="whp-schema-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Property</th>
            <th scope="col">Type</th>
            <th scope="col">Requirement</th>
            <th scope="col">Description</th>
            <th scope="col">Example</th>
          </tr>
        </thead>
        <tbody>
          {properties.length === 0 ? (
            <tr>
              <td colSpan={5}>{emptyMessage}</td>
            </tr>
          ) : (
            properties.map((property) => (
              <tr key={property.name}>
                <th scope="row">
                  <code>{property.name}</code>
                  {property.deprecated === true ? (
                    <span className="whp-table-note">Deprecated</span>
                  ) : null}
                </th>
                <td>
                  <code>{property.type}</code>
                </td>
                <td>{property.required === true ? "Required" : "Optional"}</td>
                <td>{property.description ?? "—"}</td>
                <td>
                  {property.example === undefined ? (
                    "—"
                  ) : (
                    <code>{property.example}</code>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export interface CodeSampleProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "title"
> {
  code: string;
  copyAction?: ReactNode;
  description?: ReactNode;
  language?: string;
  title?: ReactNode;
}

export function CodeSample({
  className,
  code,
  copyAction,
  description,
  language = "json",
  title = "Example payload",
  ...props
}: CodeSampleProps) {
  return (
    <figure {...props} className={classNames("whp-code-sample", className)}>
      <figcaption>
        <div>
          <strong>{title}</strong>
          {description === undefined ? null : <span>{description}</span>}
        </div>
        <div className="whp-code-sample__tools">
          <span>{language}</span>
          {copyAction}
        </div>
      </figcaption>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
