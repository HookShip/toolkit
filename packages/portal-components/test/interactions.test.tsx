// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "../src/client/copy-button.js";
import { SecretReveal } from "../src/client/secret-reveal.js";
import { Tabs } from "../src/client/tabs.js";
import {
  BackendCapabilityMatrix,
  BackendSelectionReview,
  evaluateBackendSelection,
} from "../src/backend.js";
import { EndpointInput, SubscriptionEventSelector } from "../src/endpoints.js";
import {
  backendFixtures,
  backendSelectionIssueFixtures,
  supportedBackendFixture,
  unsupportedBackendFixture,
} from "./fixtures.js";

afterEach(cleanup);

describe("client interaction boundaries", () => {
  it("reveals, copies, announces, and re-redacts a secret", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onDismiss = vi.fn();

    render(
      <SecretReveal
        initiallyRevealed
        oneTime
        onDismiss={onDismiss}
        secret="whsec_test_123"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("One-time reveal");
    expect(screen.getByLabelText("Secret value")).toHaveTextContent(
      "whsec_test_123",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss and redact" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(
      screen.getByLabelText("Secret value is hidden"),
    ).not.toHaveTextContent("whsec_test_123");
    expect(
      screen.queryByRole("button", { name: "Reveal secret" }),
    ).not.toBeInTheDocument();

    cleanup();
    render(<CopyButton value="whsec_test_123" writeText={writeText} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("whsec_test_123");
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(
      screen.getByText("Copied", { selector: "[aria-live]" }),
    ).toBeInTheDocument();

    cleanup();
    render(<SecretReveal secret="whsec_test_123" />);
    expect(
      screen.getByLabelText("Secret value is hidden"),
    ).not.toHaveTextContent("whsec_test_123");
    fireEvent.click(screen.getByRole("button", { name: "Reveal secret" }));
    expect(screen.getByLabelText("Secret value")).toHaveTextContent(
      "whsec_test_123",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide secret" }));
    expect(screen.getByLabelText("Secret value is hidden")).toBeInTheDocument();
  });

  it("implements roving keyboard tabs and omits disabled tabs", () => {
    render(
      <Tabs
        items={[
          { id: "json", label: "JSON", panel: "JSON example" },
          { id: "curl", label: "cURL", panel: "cURL example" },
          {
            disabled: true,
            id: "sdk",
            label: "SDK",
            panel: "SDK example",
          },
        ]}
        label="Code samples"
      />,
    );

    const tabList = screen.getByRole("tablist", { name: "Code samples" });
    const jsonTab = screen.getByRole("tab", { name: "JSON" });
    const curlTab = screen.getByRole("tab", { name: "cURL" });

    jsonTab.focus();
    fireEvent.keyDown(tabList, { key: "ArrowRight" });
    expect(curlTab).toHaveFocus();
    expect(curlTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("cURL example");

    fireEvent.keyDown(tabList, { key: "End" });
    expect(curlTab).toHaveFocus();
    fireEvent.keyDown(tabList, { key: "Home" });
    expect(jsonTab).toHaveFocus();
  });

  it("keeps deep-linked tabs in the URL with native link fallbacks", async () => {
    window.history.replaceState(null, "", "/reference?tab=curl");
    const { container } = render(
      <Tabs
        defaultTab="curl"
        items={[
          {
            href: "/reference?tab=json",
            id: "json",
            label: "JSON",
            panel: "JSON example",
          },
          {
            href: "/reference?tab=curl",
            id: "curl",
            label: "cURL",
            panel: "cURL example",
          },
        ]}
        label="Code samples"
        queryParam="tab"
      />,
    );

    const jsonTab = screen.getByRole("tab", { name: "JSON" });
    const curlTab = screen.getByRole("tab", { name: "cURL" });
    expect(jsonTab).toHaveAttribute("href", "/reference?tab=json");
    expect(curlTab).toHaveAttribute("aria-selected", "true");
    expect(container.querySelectorAll("[role='tabpanel']")).toHaveLength(2);
    expect(screen.getByText("JSON example")).not.toBeVisible();

    fireEvent.click(jsonTab);
    expect(window.location.search).toBe("?tab=json");
    expect(jsonTab).toHaveAttribute("aria-selected", "true");

    window.history.pushState(null, "", "/reference?tab=curl");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => {
      expect(curlTab).toHaveAttribute("aria-selected", "true");
    });
  });
});

describe("form accessibility", () => {
  it("connects labels, hints, errors, and checkbox names", () => {
    render(
      <>
        <EndpointInput
          error="Enter a valid HTTPS URL."
          hint="Requests are signed before delivery."
          id="endpoint-url"
          label="Endpoint URL"
          name="url"
          required
        />
        <SubscriptionEventSelector
          description="Choose every event this destination should receive."
          options={[
            {
              description: "Fulfillment completed.",
              name: "Order delivered",
              value: "order.delivered",
            },
          ]}
          selected={["order.delivered"]}
        />
      </>,
    );

    const input = screen.getByLabelText("Endpoint URL");
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "Requests are signed before delivery. Issue: Enter a valid HTTPS URL.",
    );
    expect(screen.getByLabelText(/Order delivered/)).toBeChecked();
    expect(screen.getByRole("group")).toHaveAccessibleDescription(
      "Choose every event this destination should receive.",
    );
  });
});

describe("backend selection review", () => {
  it("permits confirming a fully supported backend", () => {
    render(<BackendSelectionReview selection={supportedBackendFixture} />);

    const confirm = screen.getByRole("button", { name: "Confirm backend" });
    expect(confirm).toBeEnabled();
    expect(confirm).toHaveAttribute("value", "postgres");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("form")).toHaveAttribute(
      "data-can-confirm",
      "true",
    );
  });

  it("prevents confirming an unsupported backend and explains why", () => {
    render(<BackendSelectionReview selection={unsupportedBackendFixture} />);

    expect(
      screen.getByRole("button", { name: "Confirm backend" }),
    ).toBeDisabled();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Cannot confirm this backend");
    expect(alert).toHaveTextContent("BACKEND_EVALUATION_ONLY");
    expect(alert).toHaveTextContent("DURABILITY_EPHEMERAL");
  });

  it("renders deployment modes when external services are empty, without an empty facts list", () => {
    const { container } = render(
      <BackendSelectionReview selection={unsupportedBackendFixture} />,
    );

    expect(unsupportedBackendFixture.externalServices).toEqual([]);

    const facts = container.querySelector(".whp-backend-review__facts");
    expect(facts).not.toBeNull();
    const factRows = facts?.querySelectorAll("div") ?? [];
    expect(factRows).toHaveLength(1);
    expect(factRows[0]).toHaveTextContent("Deployment modes");
    expect(factRows[0]).toHaveTextContent("local");
    expect(facts).not.toHaveTextContent("Required external services");
  });

  it("omits the facts list entirely when neither external services nor deployment modes are present", () => {
    const { container } = render(
      <BackendSelectionReview
        selection={{
          ...supportedBackendFixture,
          deploymentModes: [],
          externalServices: [],
        }}
      />,
    );

    expect(container.querySelector(".whp-backend-review__facts")).toBeNull();
  });

  it("prevents confirmation when an error-severity issue is present", () => {
    render(
      <BackendSelectionReview
        issues={backendSelectionIssueFixtures}
        selection={supportedBackendFixture}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Confirm backend" }),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "MISSING_EXTERNAL_SERVICE",
    );
  });

  it("evaluates confirmation eligibility deterministically", () => {
    expect(evaluateBackendSelection(supportedBackendFixture).canConfirm).toBe(
      true,
    );

    const blocked = evaluateBackendSelection(unsupportedBackendFixture);
    expect(blocked.canConfirm).toBe(false);
    expect(blocked.blockers.map((blocker) => blocker.code)).toContain(
      "BACKEND_EVALUATION_ONLY",
    );

    const withIssue = evaluateBackendSelection(
      supportedBackendFixture,
      backendSelectionIssueFixtures,
    );
    expect(withIssue.canConfirm).toBe(false);
  });

  it("exposes an accessible, scrollable comparison table", () => {
    render(<BackendCapabilityMatrix backends={backendFixtures} />);

    const region = screen.getByRole("region", {
      name: "Backend capability comparison table",
    });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(
      screen.getByRole("columnheader", { name: /PostgreSQL/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("rowheader", { name: /Acknowledgement barrier/ }),
    ).toBeInTheDocument();
  });
});
