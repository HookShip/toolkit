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
import { EndpointInput, SubscriptionEventSelector } from "../src/endpoints.js";

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
