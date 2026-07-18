# `@webhook-portal/portal-components`

Accessible, typed React components for producer and consumer webhook portals.
The package is headless by default and ships an optional **editorial
instrumentation** theme: warm paper and ink, precise rules, signal green,
restrained operational colors, and a subtle data-grid texture.

```sh
pnpm add @webhook-portal/portal-components react react-dom
```

Version `0.1.0` supports React 18.3 and React 19. It is licensed under
Apache-2.0.

## Design principles

- **Server first.** Every entry is React Server Component and SSR safe except
  the explicitly named `client/*` entries.
- **Headless composition.** Without the optional stylesheet, components render
  semantic HTML with stable, prefixed class and data hooks.
- **Direct imports.** The root is type-only. Domain and client subpaths keep
  bundles statically analyzable and prevent an interactive primitive from
  promoting a whole portal to the client.
- **Platform semantics.** Forms submit normally, navigation uses landmarks,
  schemas use tables, disclosures use `details`, and dialogs use `dialog`.
- **No product assumptions.** Data loading, routing, mutation, permissions,
  telemetry, and toast state remain application concerns.

## Quick start

Import the optional theme once in the host:

```tsx
import "@webhook-portal/portal-components/styles.css";

import { PortalProvider } from "@webhook-portal/portal-components/provider";
import {
  Masthead,
  PageHeader,
  PortalNavigation,
  PortalShell,
} from "@webhook-portal/portal-components/shell";
import { EventCatalog } from "@webhook-portal/portal-components/events";

const events = [
  {
    id: "evt-order-delivered",
    name: "Order delivered",
    description: "Emitted after an order clears fulfillment.",
    category: "Orders",
    version: "2026-07-01",
    href: "/events/order.delivered",
  },
];

export default function PortalPage() {
  return (
    <PortalProvider theme="paper">
      <PortalShell
        masthead={<Masthead brand="Relay Manual" />}
        navigation={
          <PortalNavigation
            items={[
              { current: true, href: "/events", label: "Events" },
              { href: "/endpoints", label: "Endpoints" },
              { href: "/deliveries", label: "Deliveries" },
            ]}
          />
        }
      >
        <PageHeader
          description="Versioned contracts and delivery instrumentation."
          eyebrow="Production"
          title="Webhook operations"
        />
        <EventCatalog events={events} />
      </PortalShell>
    </PortalProvider>
  );
}
```

Omit the CSS import to use only the semantic structure and style it through your
own classes or `[data-*]` selectors.

## Server and client boundaries

| Entry                   | Boundary    | Includes                                                                   |
| ----------------------- | ----------- | -------------------------------------------------------------------------- |
| `/provider`             | Server safe | `PortalProvider`, theme attributes and token overrides                     |
| `/shell`                | Server safe | `PortalShell`, `Masthead`, `Breadcrumbs`, `PortalNavigation`, `PageHeader` |
| `/events`               | Server safe | Catalog/cards, detail, version form, schema table, code sample             |
| `/endpoints`            | Server safe | Lists/cards, form fields, event subscription selector                      |
| `/secrets`              | Server safe | Redacted display, one-time warning, rotation state                         |
| `/deliveries`           | Server safe | Timeline, attempts, filters, statuses, replay/test forms                   |
| `/states`               | Server safe | Empty, loading, issue, unsupported, deletion, export                       |
| `/session`              | Server safe | Delegated-session expiry and re-auth composition                           |
| `/primitives`           | Server safe | Badges, buttons, disclosure, dialog, live/toast regions                    |
| `/client/copy-button`   | Client      | Clipboard interaction and live announcement                                |
| `/client/secret-reveal` | Client      | Local reveal/redact state and copy action                                  |
| `/client/tabs`          | Client      | URL-aware ARIA tabs with keyboard navigation and native link fallbacks     |

The package root exports shared types only:

```ts
import type {
  DeliveryAttempt,
  EndpointSummary,
  EventSummary,
} from "@webhook-portal/portal-components";
```

## Events and schemas

`VersionSwitcher` is a native form rather than a hydrated select. Route the
query in your framework or pass a server action through the form props.

```tsx
import {
  CodeSample,
  EventDetail,
  SchemaPropertyTable,
  VersionSwitcher,
} from "@webhook-portal/portal-components/events";
import { CopyButton } from "@webhook-portal/portal-components/client/copy-button";

const payload = JSON.stringify(
  {
    id: "evt_01J2Y8",
    type: "order.delivered",
    data: { order_id: "ord_01J2Y8" },
  },
  null,
  2,
);

export function OrderDeliveredContract() {
  return (
    <EventDetail
      eventName="Order delivered"
      eventType="order.delivered"
      version="2026-07-01"
    >
      <VersionSwitcher
        action="/events/order.delivered"
        current="2026-07-01"
        hiddenFields={{ tab: "schema" }}
        id="order-delivered-version"
        versions={[
          { value: "2026-07-01" },
          { deprecated: true, value: "2024-01-01" },
        ]}
      />
      <SchemaPropertyTable
        properties={[
          {
            name: "data.order_id",
            type: "string",
            required: true,
            description: "Canonical order identifier.",
          },
        ]}
      />
      <CodeSample
        code={payload}
        copyAction={<CopyButton value={payload} />}
        language="json"
      />
    </EventDetail>
  );
}
```

Importing `CopyButton` introduces a small client island only around the copy
control. The contract, table, and source remain server-rendered.
`VersionSwitcher.hiddenFields` preserves related query state such as the active
documentation tab.

## Endpoints and subscriptions

```tsx
import {
  EndpointForm,
  EndpointInput,
  EndpointSelect,
  SubscriptionEventSelector,
} from "@webhook-portal/portal-components/endpoints";
import { PortalButton } from "@webhook-portal/portal-components/primitives";

export function CreateEndpoint() {
  return (
    <EndpointForm
      action="/endpoints"
      method="post"
      title="Create endpoint"
      actions={
        <PortalButton tone="primary" type="submit">
          Create endpoint
        </PortalButton>
      }
    >
      <EndpointInput
        hint="Public HTTPS endpoint. Requests are signed before delivery."
        id="endpoint-url"
        label="Endpoint URL"
        name="url"
        required
        type="url"
      />
      <EndpointSelect
        defaultValue="production"
        id="environment"
        label="Environment"
        name="environment"
        options={[
          { label: "Production", value: "production" },
          { label: "Sandbox", value: "sandbox" },
        ]}
        required
      />
      <SubscriptionEventSelector
        options={[
          {
            name: "Order delivered",
            value: "order.delivered",
            version: "2026-07-01",
          },
        ]}
      />
    </EndpointForm>
  );
}
```

Field errors are visible text, set `aria-invalid`, and are included in
`aria-describedby`. The subscription selector is a native fieldset with
label-wrapped checkboxes.

## Secrets and rotation

Keep redacted secrets server-rendered. Use the client reveal only when the
plaintext has already been intentionally delivered to the browser:

```tsx
import { SecretReveal } from "@webhook-portal/portal-components/client/secret-reveal";
import {
  RedactedSecret,
  SecretRotationState,
} from "@webhook-portal/portal-components/secrets";

export function ExistingSecret() {
  return <RedactedSecret label="Production signing secret" />;
}

export function NewlyCreatedSecret({
  onDismiss,
  value,
}: {
  onDismiss: () => void;
  value: string;
}) {
  return (
    <SecretReveal
      initiallyRevealed
      oneTime
      onDismiss={onDismiss}
      secret={value}
    />
  );
}

export function Rotation() {
  return (
    <SecretRotationState
      currentKey={<code>key_01J2</code>}
      nextChangeAt="2026-07-18T02:00:00Z"
      nextChangeAtLabel="18 July at 02:00 UTC"
      nextKey={<code>key_01J3</code>}
      status="overlap"
    />
  );
}
```

`SecretReveal` does not render the plaintext into the DOM until the user asks to
reveal it. As with any client component, its serialized prop is still available
to the browser; never pass a secret the current user is not authorized to
receive. In one-time mode, dismissal is irreversible. Use `onDismiss` to clear
the secret from the parent action/local state rather than retaining it for a
later reveal.

## Deliveries and actions

Timeline data is passed in one render, avoiding component-owned fetch
waterfalls. Attempt rows use `content-visibility: auto` in the default theme.

```tsx
import {
  DeliveryFilters,
  DeliveryTimeline,
  ReplayDeliveryAction,
  TestEndpointAction,
} from "@webhook-portal/portal-components/deliveries";

export function Deliveries({ attempts }) {
  return (
    <>
      <DeliveryFilters
        action="/deliveries"
        endpoints={[{ label: "Production", value: "ep_prod" }]}
        method="get"
      />
      <DeliveryTimeline attempts={attempts} />
      <ReplayDeliveryAction
        action="/deliveries/dlv_01/replay"
        hiddenFields={{ attempt: "latest" }}
      />
      <TestEndpointAction action="/endpoints/ep_prod/test" />
    </>
  );
}
```

Disabled action affordances remain keyboard-focusable and include a textual
reason:

```tsx
<ReplayDeliveryAction
  action="/deliveries/dlv_01/replay"
  disabledReason="This provider does not support replay."
/>
```

## Operational states

`/states` includes:

- `EmptyState`
- `LoadingState`
- `IssueState`
- `UnsupportedCapability`
- `DeletionState`
- `ExportState`

`DelegatedSessionExpired` lives at `/session` and accepts an `actions` slot for
the host's re-auth link or form. Statuses always include text and semantics;
color is supplementary.

## Theme tokens

`PortalProvider` writes token overrides as inline custom properties without
context or hydration:

```tsx
<PortalProvider
  density="compact"
  theme="ink"
  tokens={{
    accent: "#0a7a42",
    fontDisplay: '"Newsreader", Georgia, serif',
    fontBody: '"Söhne", "Avenir Next", sans-serif',
    radius: "2px",
  }}
>
  {children}
</PortalProvider>
```

Stable public variables include:

- `--whp-color-background`, `--whp-color-surface`, `--whp-color-ink`
- `--whp-color-muted`, `--whp-color-border`
- `--whp-color-accent`, `--whp-color-warning`, `--whp-color-critical`
- `--whp-font-display`, `--whp-font-body`, `--whp-font-mono`
- `--whp-radius`

Use `theme="paper"`, `theme="ink"`, or `theme="auto"`. The stylesheet is scoped
beneath `.whp`; it does not style `html`, `body`, or unrelated host elements.

## Accessibility and performance

- Semantic landmarks, lists, tables, fieldsets, captions, labels, and time
  elements are rendered on the server.
- Focus-visible rings, high-contrast/forced-color behavior, reduced-motion
  behavior, textual status labels, and horizontally scrollable schema tables are
  included in the optional theme.
- Layouts use fluid/container-responsive grids and avoid fixed content heights,
  preserving navigation and actions at 200% zoom.
- The timeline uses `content-visibility` with an intrinsic-size fallback.
- No component fetches data, mutates module-level request state, or introduces
  an async waterfall.
- Interactive entry points are isolated and use no third-party runtime
  dependencies.
- Tabs implement roving focus with Arrow Left/Right, Home, and End. Optional
  per-tab `href` values provide no-JavaScript navigation, while `queryParam`
  keeps history and back/forward navigation synchronized. Inactive panel content
  remains in the DOM so print styles can expose the full reference.
- Dialogs connect title/description semantics, contain overscroll, and account
  for viewport safe areas. Disclosure and dialog behavior otherwise defer to
  platform semantics.
- `LiveRegion` and `ToastRegion` provide presentation semantics only; hosts own
  state so the portal tree does not subscribe to a global store.

## Validation

The package includes SSR renders, semantic outline snapshots, interaction and
keyboard tests, form-accessibility assertions, a visual token contract, and a
tarball smoke test.

```sh
pnpm --filter @webhook-portal/portal-components lint
pnpm --filter @webhook-portal/portal-components typecheck
pnpm --filter @webhook-portal/portal-components test
pnpm --filter @webhook-portal/portal-components build
pnpm --filter @webhook-portal/portal-components pack:smoke
```
