// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  computeResolutionDuration,
  createEvidenceBundle,
  escapeMarkdownText,
  renderEvidenceJson,
  renderEvidenceMarkdown,
  stableJson,
} from "../src/index.js";
import { validEvidenceInput } from "./fixtures.js";

describe("safe evidence renderers", () => {
  it("renders stable JSON evidence and explicit limitations", () => {
    const bundle = createEvidenceBundle(validEvidenceInput());
    const first = renderEvidenceJson(bundle);
    const second = renderEvidenceJson(structuredClone(bundle));
    const parsed = JSON.parse(first) as Record<string, unknown>;

    expect(first).toBe(second);
    expect(first.startsWith('{\n  "evidence"')).toBe(true);
    expect(parsed["format"]).toBe("webhook-portal.support-evidence-summary");
    expect(first).toContain('"limitations"');
    expect(first).not.toMatch(/diagnos|blame/iu);
  });

  it("escapes active Markdown and HTML syntax", () => {
    const unsafe = "<script>alert(1)</script> | [click](javascript:alert(1))";
    const escaped = escapeMarkdownText(unsafe);

    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("| [click](");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("\\[click\\]\\(javascript:alert\\(1\\)\\)");

    const rendered = renderEvidenceMarkdown(
      createEvidenceBundle(validEvidenceInput()),
    );
    expect(rendered).toContain("# Support evidence bundle");
    expect(rendered).toContain("## Timeline metadata");
    expect(rendered).toContain("## Limitations");
    expect(rendered).not.toMatch(/diagnos|blame/iu);
  });

  it("uses embedding-safe, deterministic JSON escaping", () => {
    expect(stableJson({ value: "</script>&\u2028" })).toContain(
      '"\\u003c/script\\u003e\\u0026\\u2028"',
    );
  });

  it("never contains rejected plaintext values", () => {
    const rendered = renderEvidenceJson(
      createEvidenceBundle(validEvidenceInput()),
    );
    for (const plaintext of [
      "plaintext-sensitive-value",
      "operator@example.test",
      "4111111111111111",
      "https://example.test/private",
    ]) {
      expect(rendered).not.toContain(plaintext);
    }
  });
});

describe("resolution duration metric", () => {
  it("computes duration only from supplied case timestamps", () => {
    expect(
      computeResolutionDuration({
        openedAt: "2026-07-18T10:00:00.000Z",
        resolvedAt: "2026-07-18T10:03:30.000Z",
      }),
    ).toEqual({
      status: "available",
      openedAt: "2026-07-18T10:00:00.000Z",
      resolvedAt: "2026-07-18T10:03:30.000Z",
      durationMs: 210_000,
    });
    expect(
      computeResolutionDuration({
        openedAt: "2026-07-18T10:00:00.000Z",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "resolved-at-not-supplied",
      openedAt: "2026-07-18T10:00:00.000Z",
    });
  });

  it("rejects inferred or inconsistent case fields", () => {
    expect(() =>
      computeResolutionDuration({
        openedAt: "2026-07-18T10:00:00.000Z",
        closedAt: "2026-07-18T10:03:30.000Z",
      }),
    ).toThrowError(/unknown field/iu);
    expect(() =>
      computeResolutionDuration({
        openedAt: "2026-07-18T10:03:30.000Z",
        resolvedAt: "2026-07-18T10:00:00.000Z",
      }),
    ).toThrowError(/cannot precede/iu);
  });
});
