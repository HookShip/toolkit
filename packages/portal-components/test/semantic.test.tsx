// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DeliveryFilters, DeliveryTimeline } from "../src/deliveries.js";
import { EndpointList } from "../src/endpoints.js";
import {
  CodeSample,
  EventCatalog,
  SchemaPropertyTable,
} from "../src/events.js";
import { PortalProvider } from "../src/provider.js";
import { PortalButton } from "../src/primitives.js";
import {
  Breadcrumbs,
  Masthead,
  PageHeader,
  PortalNavigation,
  PortalShell,
} from "../src/shell.js";
import { DeletionState, EmptyState, ExportState } from "../src/states.js";
import {
  attemptFixtures,
  endpointFixtures,
  eventFixtures,
  schemaFixtures,
} from "./fixtures.js";

afterEach(cleanup);

function semanticOutline(container: HTMLElement): string[] {
  const selectors = [
    "header",
    "nav",
    "main",
    "section",
    "article",
    "h1",
    "h2",
    "h3",
    "form",
    "table",
    "caption",
    "ol",
  ].join(",");

  return Array.from(container.querySelectorAll(selectors), (element) => {
    const label =
      element.getAttribute("aria-label") ??
      element.querySelector(":scope > h1, :scope > h2, :scope > h3")
        ?.textContent ??
      element.textContent ??
      "";
    const conciseLabel = label.replace(/\s+/g, " ").trim().slice(0, 48);
    return `${element.tagName.toLowerCase()}${conciseLabel ? `: ${conciseLabel}` : ""}`;
  });
}

describe("semantic portal composition", () => {
  it("keeps a stable landmark and heading outline", () => {
    const { container } = render(
      <PortalProvider>
        <PortalShell
          masthead={<Masthead brand="Relay Manual" />}
          navigation={
            <PortalNavigation
              items={[
                { current: true, href: "/events", label: "Events" },
                { href: "/endpoints", label: "Endpoints" },
              ]}
            />
          }
        >
          <PageHeader
            actions={<PortalButton>Create endpoint</PortalButton>}
            breadcrumbs={
              <Breadcrumbs
                items={[{ href: "/", label: "Home" }, { label: "Events" }]}
              />
            }
            description="Contracts and delivery instrumentation."
            title="Webhook operations"
          />
          <EventCatalog events={eventFixtures} />
          <EndpointList endpoints={endpointFixtures} />
          <DeliveryFilters />
          <DeliveryTimeline attempts={attemptFixtures} />
          <SchemaPropertyTable properties={schemaFixtures} />
          <CodeSample code={'{"type":"order.delivered"}'} />
        </PortalShell>
      </PortalProvider>,
    );

    expect(semanticOutline(container)).toMatchInlineSnapshot(`
      [
        "header: Skip to contentRelay Manual",
        "nav: Portal navigation",
        "main: HomeEventsWebhook operationsContracts and delive",
        "header: HomeEventsWebhook operationsContracts and delive",
        "nav: Breadcrumb",
        "ol: HomeEvents",
        "h1: Webhook operations",
        "section: Contract surfaceEvent catalogevt-order-delivered",
        "header: Contract surfaceEvent catalog",
        "h2: Event catalog",
        "article: Order delivered",
        "h3: Order delivered",
        "article: Account activated",
        "h3: Account activated",
        "section: Delivery surfaceEndpointsActiveProduction ingest",
        "header: Delivery surfaceEndpoints",
        "h2: Endpoints",
        "article: ActiveProduction ingestionhttps://hooks.example.",
        "h3: Production ingestion",
        "form: Search deliveriesStatusAll statusesQueuedPending",
        "section: Attempt ledgerDelivery timelineAttempt 117 Jul 2",
        "header: Attempt ledgerDelivery timeline",
        "h2: Delivery timeline",
        "ol: Attempt 117 Jul 2026, 01:16:42 UTCDelivered184 m",
        "article: Attempt 117 Jul 2026, 01:16:42 UTCDelivered184 m",
        "table: Payload propertiesPropertyTypeRequirementDescrip",
        "caption: Payload properties",
      ]
    `);
  });

  it("supports route-appropriate heading levels for reusable states", () => {
    render(
      <section aria-labelledby="operations-heading">
        <h2 id="operations-heading">Operations</h2>
        <EmptyState headingLevel={3} title="No operations" />
        <DeletionState
          headingLevel={4}
          operationId="deletion_01"
          status="unknown"
        />
        <ExportState headingLevel={4} operationId="export_01" status="failed" />
        <ExportState
          headingLevel={4}
          operationId="export_02"
          status="ready"
          title="Export ready, download unavailable"
        />
      </section>,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "No operations" }).tagName,
    ).toBe("H3");
    expect(
      screen.getByRole("heading", {
        level: 4,
        name: "Deletion status unavailable",
      }).tagName,
    ).toBe("H4");
    expect(
      screen.getByRole("heading", {
        level: 4,
        name: "Export could not complete",
      }).tagName,
    ).toBe("H4");
    expect(screen.getByText("deletion_01")).toBeDefined();
    expect(screen.getByText("export_01")).toBeDefined();
    expect(
      screen.getByRole("heading", {
        level: 4,
        name: "Export ready, download unavailable",
      }),
    ).toBeDefined();
    expect(screen.getByText("export_02")).toBeDefined();
  });
});
