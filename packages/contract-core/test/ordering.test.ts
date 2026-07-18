// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compareCodeUnits } from "../src/index.js";

describe("locale-independent canonical ordering", () => {
  it("produces identical checksums in child processes with different locales", () => {
    const script = fileURLToPath(
      new URL("./checksum-child.mjs", import.meta.url),
    );
    const results = ["C", "en_US.UTF-8", "tr_TR.UTF-8"].map(
      (locale) =>
        JSON.parse(
          execFileSync(process.execPath, [script], {
            encoding: "utf8",
            env: { ...process.env, LANG: locale, LC_ALL: locale },
            timeout: 15_000,
          }),
        ) as { readonly checksum: string; readonly events: readonly string[] },
    );

    expect(new Set(results.map(({ checksum }) => checksum)).size).toBe(1);
    expect(
      new Set(results.map(({ events }) => JSON.stringify(events))).size,
    ).toBe(1);
    expect(results[0]?.events).toEqual(
      ["zeta", "ävent", "İvent", "event", "Ωmega"].sort(compareCodeUnits),
    );
  }, 60_000);

  it("never executes catastrophic user regexes in-process", () => {
    const script = fileURLToPath(new URL("./regex-child.mjs", import.meta.url));
    const output = JSON.parse(
      execFileSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 5_000,
      }),
    ) as {
      readonly diagnostic: boolean;
      readonly pattern: string;
      readonly status: string;
    };
    expect(output).toEqual({
      diagnostic: true,
      pattern: "^(a|aa)+$",
      status: "partial",
    });
  }, 10_000);
});
