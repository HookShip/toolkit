// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MIGRATION_INVENTORY_SCHEMA_ID } from "../src/index.js";

function json(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

describe("publish contract", () => {
  it("publishes version 0.1.0 under Apache-2.0 with documented subpaths", () => {
    const packageJson = json("../package.json");
    const exports = packageJson["exports"] as Record<string, unknown>;

    expect(packageJson["version"]).toBe("0.1.0");
    expect(packageJson["license"]).toBe("Apache-2.0");
    expect(Object.keys(exports)).toEqual(
      expect.arrayContaining([
        ".",
        "./assessment",
        "./examples",
        "./import",
        "./render",
        "./schema",
        "./schema.json",
        "./types",
        "./examples/custom-http.json",
        "./examples/hookdeck.json",
        "./examples/svix.json",
      ]),
    );
  });

  it("ships the versioned closed inventory schema", () => {
    const schema = json("../schema/migration-inventory.schema.json");

    expect(schema["$id"]).toBe(MIGRATION_INVENTORY_SCHEMA_ID);
    expect(schema["additionalProperties"]).toBe(false);
  });
});
