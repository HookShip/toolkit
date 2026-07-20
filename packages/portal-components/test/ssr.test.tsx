// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CopyButton } from "../src/client/copy-button.js";
import { SecretReveal } from "../src/client/secret-reveal.js";
import { Tabs } from "../src/client/tabs.js";
import {
  BackendCapabilityMatrix,
  BackendSelectionReview,
} from "../src/backend.js";
import { DeliveryTimeline } from "../src/deliveries.js";
import {
  EndpointForm,
  EndpointInput,
  SubscriptionEventSelector,
} from "../src/endpoints.js";
import { EventDetail, VersionSwitcher } from "../src/events.js";
import { PortalProvider } from "../src/provider.js";
import {
  Disclosure,
  LiveRegion,
  PortalDialog,
  ToastRegion,
} from "../src/primitives.js";
import {
  OneTimeRevealWarning,
  RedactedSecret,
  SecretRotationState,
} from "../src/secrets.js";
import { DelegatedSessionExpired } from "../src/session.js";
import {
  DeletionState,
  EmptyState,
  ExportState,
  IssueState,
  LoadingState,
  UnsupportedCapability,
} from "../src/states.js";
import {
  attemptFixtures,
  backendFixtures,
  supportedBackendFixture,
  unsupportedBackendFixture,
} from "./fixtures.js";

describe("server rendering", () => {
  it("renders the complete server-safe surface without browser globals", () => {
    const markup = renderToStaticMarkup(
      <PortalProvider
        theme="auto"
        tokens={{ accent: "#087a43", radius: "0.25rem" }}
      >
        <EventDetail
          eventName="Order delivered"
          eventType="order.delivered"
          version="2026-07-01"
        >
          <VersionSwitcher
            current="2026-07-01"
            id="event-version"
            versions={[
              { value: "2026-07-01" },
              { deprecated: true, value: "2024-01-01" },
            ]}
          />
        </EventDetail>
        <EndpointForm title="Create endpoint">
          <EndpointInput
            hint="HTTPS only."
            id="endpoint-url"
            label="Endpoint URL"
            name="url"
            required
          />
          <SubscriptionEventSelector
            options={[{ name: "Order delivered", value: "order.delivered" }]}
          />
        </EndpointForm>
        <RedactedSecret />
        <OneTimeRevealWarning />
        <SecretRotationState status="overlap" />
        <DeliveryTimeline attempts={attemptFixtures} />
        <BackendCapabilityMatrix backends={backendFixtures} />
        <BackendSelectionReview selection={supportedBackendFixture} />
        <EmptyState title="No endpoints" />
        <LoadingState />
        <IssueState details={<code>request_id=req_01</code>} />
        <UnsupportedCapability capability="delivery.replay" />
        <DeletionState status="scheduled" />
        <ExportState progress={42} status="preparing" />
        <DelegatedSessionExpired />
        <Disclosure summary="Details">Native disclosure</Disclosure>
        <PortalDialog open title="Confirm deletion" titleId="delete-title">
          Dialog content
        </PortalDialog>
        <LiveRegion>Updated</LiveRegion>
        <ToastRegion>
          <li>Endpoint saved</li>
        </ToastRegion>
      </PortalProvider>,
    );

    expect(markup).toContain('data-whp-theme="auto"');
    expect(markup).toContain("--whp-color-accent:#087a43");
    expect(markup).toContain("<dialog");
    expect(markup).toContain("<details");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("undefined");
  });

  it("renders empty collections with explicit text rather than empty landmarks", () => {
    const markup = renderToStaticMarkup(<DeliveryTimeline attempts={[]} />);

    expect(markup).toContain("No delivery attempts yet.");
  });

  it("server-gates backend confirmation on declared support", () => {
    const supported = renderToStaticMarkup(
      <BackendSelectionReview selection={supportedBackendFixture} />,
    );
    expect(supported).toContain('data-can-confirm="true"');
    expect(supported).toContain("Confirm backend");
    expect(supported).not.toContain("disabled=");
    expect(supported).not.toContain("Cannot confirm this backend");

    const blocked = renderToStaticMarkup(
      <BackendSelectionReview selection={unsupportedBackendFixture} />,
    );
    expect(blocked).toContain('data-can-confirm="false"');
    expect(blocked).toContain("disabled=");
    expect(blocked).toContain("Cannot confirm this backend");
    expect(blocked).toContain("BACKEND_EVALUATION_ONLY");
    expect(blocked).toContain('role="alert"');
    expect(blocked).not.toContain("undefined");
  });

  it("renders a comparison matrix with a caption and per-backend columns", () => {
    const markup = renderToStaticMarkup(
      <BackendCapabilityMatrix backends={backendFixtures} />,
    );

    expect(markup).toContain(
      "<caption>Backend capability comparison</caption>",
    );
    expect(markup).toContain("PostgreSQL");
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Acknowledgement barrier");
    expect(markup).toContain('data-status="unsupported"');
    expect(markup).not.toContain("undefined");
  });

  it("server-renders deterministic client islands without browser access", () => {
    const markup = renderToStaticMarkup(
      <>
        <CopyButton value="payload" />
        <SecretReveal secret="whsec_not_in_initial_markup" />
        <Tabs
          items={[
            { id: "json", label: "JSON", panel: "JSON body" },
            { id: "curl", label: "cURL", panel: "cURL command" },
          ]}
          label="Samples"
        />
      </>,
    );

    expect(markup).toContain("Reveal secret");
    expect(markup).not.toContain("whsec_not_in_initial_markup");
    expect(markup).toContain("JSON body");
    expect(markup).toContain('data-print-label="cURL" hidden=""');
    expect(markup).toContain("cURL command");
  });
});
