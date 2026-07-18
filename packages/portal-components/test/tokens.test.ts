// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL("../styles/portal.css", import.meta.url);

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function token(block: string, name: string): string {
  const value = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  if (value === undefined) throw new Error(`Missing color token ${name}`);
  return value;
}

describe("visual token contract", () => {
  it("publishes the stable theme tokens", async () => {
    const stylesheet = await readFile(stylesheetUrl, "utf8");
    const tokenNames = Array.from(
      stylesheet.matchAll(/--whp-[a-z0-9-]+(?=:)/g),
      ([token]) => token,
    );
    const uniqueTokens = [...new Set(tokenNames)].sort();

    expect(uniqueTokens).toMatchInlineSnapshot(`
      [
        "--whp-color-accent",
        "--whp-color-accent-soft",
        "--whp-color-accent-strong",
        "--whp-color-background",
        "--whp-color-border",
        "--whp-color-border-strong",
        "--whp-color-critical",
        "--whp-color-critical-soft",
        "--whp-color-faint",
        "--whp-color-grid",
        "--whp-color-info",
        "--whp-color-info-soft",
        "--whp-color-ink",
        "--whp-color-muted",
        "--whp-color-on-accent",
        "--whp-color-on-critical",
        "--whp-color-surface",
        "--whp-color-surface-raised",
        "--whp-color-warning",
        "--whp-color-warning-soft",
        "--whp-control-height",
        "--whp-font-body",
        "--whp-font-display",
        "--whp-font-mono",
        "--whp-line",
        "--whp-radius",
        "--whp-radius-large",
        "--whp-shadow-raised",
        "--whp-space-1",
        "--whp-space-2",
        "--whp-space-3",
        "--whp-space-4",
        "--whp-space-5",
        "--whp-space-6",
        "--whp-space-7",
        "--whp-space-8",
      ]
    `);
  });

  it("keeps styling scoped and includes rendering/accessibility contracts", async () => {
    const stylesheet = await readFile(stylesheetUrl, "utf8");

    expect(stylesheet).toContain("content-visibility: auto");
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    expect(stylesheet).toContain("@media (forced-colors: active)");
    expect(stylesheet).toContain("@container (max-width: 38rem)");
    expect(stylesheet).toContain(":focus-visible");
    expect(stylesheet).toContain("overscroll-behavior: contain");
    expect(stylesheet).toContain("env(safe-area-inset-top)");
    expect(stylesheet).toContain("scroll-margin-block-start");
    expect(stylesheet).not.toMatch(/(^|\})\s*(body|html|\*)\s*\{/m);
  });

  it("keeps small editorial text at WCAG AA contrast in every theme", async () => {
    const stylesheet = await readFile(stylesheetUrl, "utf8");
    const paper = stylesheet.match(/\.whp\s*\{([\s\S]*?)\n\}/)?.[1];
    const ink = stylesheet.match(
      /\.whp\[data-whp-theme="ink"\]\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(paper).toBeDefined();
    expect(ink).toBeDefined();

    const cases = [
      [
        token(paper!, "--whp-color-faint"),
        token(paper!, "--whp-color-background"),
      ],
      [
        token(paper!, "--whp-color-faint"),
        token(paper!, "--whp-color-surface-raised"),
      ],
      [
        token(paper!, "--whp-color-warning"),
        token(paper!, "--whp-color-warning-soft"),
      ],
      [
        token(ink!, "--whp-color-faint"),
        token(ink!, "--whp-color-surface-raised"),
      ],
      [
        token(ink!, "--whp-color-warning"),
        token(ink!, "--whp-color-warning-soft"),
      ],
    ] as const;

    for (const [foreground, background] of cases) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
