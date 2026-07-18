// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CANONICAL_MODEL_VERSION,
  CANONICAL_EXPORT_FORMAT,
  CANONICAL_EXPORT_VERSION,
  CANONICAL_SCHEMA_ID,
  isCanonicalContract,
  isCanonicalContractExport,
  isJsonValue,
  isSha256Checksum,
  unicodeCodePointLength,
  type CanonicalContract,
} from "../src/index.js";

const checksum = {
  algorithm: "sha256",
  value: "a".repeat(64),
} as const;

describe("canonical string semantics", () => {
  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(unicodeCodePointLength("😀")).toBe(1);
    expect(unicodeCodePointLength("a😀b")).toBe(3);
  });
});

describe("canonical model guards", () => {
  it("accepts portable JSON and rejects unsafe or cyclic objects", () => {
    expect(isJsonValue({ nested: [1, true, null, "value"] })).toBe(true);
    expect(isJsonValue(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(
      false,
    );

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);

    let accessed = false;
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        accessed = true;
        return "unsafe";
      },
    });
    expect(isJsonValue(accessor)).toBe(false);
    expect(accessed).toBe(false);
  });

  it("recognizes checksums and canonical contracts", () => {
    expect(isSha256Checksum(checksum)).toBe(true);

    const contract: CanonicalContract = {
      $schema: CANONICAL_SCHEMA_ID,
      checksum,
      eventTypes: [
        {
          externalName: "order.created",
          id: "evt_order_created",
          versions: [
            {
              examples: [{ name: "sample", value: { id: "ord_1" } }],
              id: "evt_order_created_v1",
              publicVersion: "1",
              schema: {
                checksum,
                dialect: "https://json-schema.org/draft/2020-12/schema",
                value: { type: "object" },
              },
              source: { pointer: "/webhooks/order.created/post" },
            },
          ],
        },
      ],
      id: "contract_example",
      modelVersion: CANONICAL_MODEL_VERSION,
      source: {
        format: "openapi",
        mediaType: "application/json",
        parser: { name: "contract-core", version: "1.0.0" },
        sourceChecksum: checksum,
        specificationVersion: "3.1.0",
      },
    };

    expect(isCanonicalContract(contract)).toBe(true);
    expect(isCanonicalContract({ ...contract, modelVersion: "2" })).toBe(false);

    const missingDialect = structuredClone(contract) as unknown as Record<
      string,
      unknown
    >;
    const eventTypes = missingDialect["eventTypes"] as Record<
      string,
      unknown
    >[];
    const versions = eventTypes[0]?.["versions"] as Record<string, unknown>[];
    const schema = versions[0]?.["schema"] as Record<string, unknown>;
    delete schema["dialect"];
    expect(isCanonicalContract(missingDialect)).toBe(false);

    const missingSource = structuredClone(contract) as unknown as Record<
      string,
      unknown
    >;
    delete missingSource["source"];
    expect(isCanonicalContract(missingSource)).toBe(false);

    const missingEventSource = structuredClone(contract) as unknown as Record<
      string,
      unknown
    >;
    const missingSourceEvents = missingEventSource["eventTypes"] as Record<
      string,
      unknown
    >[];
    const missingSourceVersions = missingSourceEvents[0]?.[
      "versions"
    ] as Record<string, unknown>[];
    delete missingSourceVersions[0]?.["source"];
    expect(isCanonicalContract(missingEventSource)).toBe(false);

    const missingExampleValue = structuredClone(contract) as unknown as Record<
      string,
      unknown
    >;
    const exampleEvents = missingExampleValue["eventTypes"] as Record<
      string,
      unknown
    >[];
    const exampleVersions = exampleEvents[0]?.["versions"] as Record<
      string,
      unknown
    >[];
    const examples = exampleVersions[0]?.["examples"] as Record<
      string,
      unknown
    >[];
    delete examples[0]?.["value"];
    expect(isCanonicalContract(missingExampleValue)).toBe(false);

    const exported = {
      canonical: contract,
      checksums: { canonical: checksum, source: checksum },
      format: CANONICAL_EXPORT_FORMAT,
      formatVersion: CANONICAL_EXPORT_VERSION,
      original: {
        kind: "document",
        mediaType: "application/json",
        value: { openapi: "3.1.0" },
      },
    };
    expect(isCanonicalContractExport(exported)).toBe(true);
    const missingOriginal = structuredClone(exported) as unknown as Record<
      string,
      unknown
    >;
    delete (missingOriginal["original"] as Record<string, unknown>)["value"];
    expect(isCanonicalContractExport(missingOriginal)).toBe(false);
  });
});
