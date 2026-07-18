// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../package.json", import.meta.url);

describe("package contract", () => {
  it("is public, licensed, tree-analyzable, and CSS-optional", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
      exports: Record<string, unknown>;
      files: string[];
      license: string;
      peerDependencies: Record<string, string>;
      private?: boolean;
      sideEffects: string[];
      version: string;
    };

    expect(packageJson.version).toBe("0.1.0");
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.peerDependencies.react).toBe(">=18.3 <20");
    expect(packageJson.peerDependencies["react-dom"]).toBe(">=18.3 <20");
    expect(packageJson.exports).toHaveProperty("./client/secret-reveal");
    expect(packageJson.exports).toHaveProperty("./styles.css");
    expect(packageJson.sideEffects).toEqual(["./styles/*.css"]);
    expect(packageJson.files).not.toContain("src");
    expect(packageJson.files).not.toContain("test");
  });
});
