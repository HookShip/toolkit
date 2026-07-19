// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canonicalizeContract,
  importContract,
  parseContract,
  resolveLimits,
  validateContract,
  type JsonObject,
  type JsonValue,
} from "../src/index.js";

function minimalOpenApi(extra: JsonObject = {}): JsonObject {
  return {
    ...extra,
    info: { title: "Security", version: "1" },
    openapi: "3.1.0",
    webhooks: {
      event: {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          responses: {
            "200": { description: "Accepted" },
          },
          "x-event-type": "event",
        },
      },
    },
  };
}

describe("parser resource and object safety", () => {
  it("derives bounded output headroom from explicit input limits", () => {
    expect(resolveLimits({ maxInputBytes: 4 * 1024 * 1024 })).toMatchObject({
      maxInputBytes: 4 * 1024 * 1024,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    expect(
      resolveLimits({
        maxInputBytes: 4 * 1024 * 1024,
        maxOutputBytes: 600 * 1024,
      }).maxOutputBytes,
    ).toBe(600 * 1024);
  });

  it("rejects duplicate JSON members at every depth before conversion", () => {
    for (const [input, pointer] of [
      [
        '{"openapi":"3.1.0","openapi":"3.1.1","info":{"title":"x","version":"1"},"webhooks":{}}',
        "/openapi",
      ],
      [
        '{"openapi":"3.1.0","info":{"title":"first","title":"second","version":"1"},"webhooks":{}}',
        "/info/title",
      ],
      [
        '{"openapi":"3.1.0","info":{"title":"first","\\u0074itle":"second","version":"1"},"webhooks":{}}',
        "/info/title",
      ],
      [
        '{"openapi":"3.1.0","info":{"title":"x","version":"1"},"webhooks":{"event":{"post":{"responses":{},"responses":{}}}}}',
        "/webhooks/event/post/responses",
      ],
      ['[{"nested":{"value":1,"value":2}}]', "/0/nested/value"],
    ] as const) {
      const result = parseContract(input, { formatHint: "json" });
      expect(result.ok).toBe(false);
      expect(result.document).toBeUndefined();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "JSON_DUPLICATE_OBJECT_MEMBER",
          pointer,
          severity: "fatal",
        }),
      );
    }
  });

  it("rejects prototype-pollution keys without mutating prototypes", () => {
    const input =
      '{"openapi":"3.1.0","info":{"title":"x","version":"1"},"webhooks":{},"__proto__":{"polluted":true}}';
    const result = parseContract(input);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "UNSAFE_OBJECT_KEY",
        pointer: "/__proto__",
      }),
    );
    expect(
      (Object.prototype as { polluted?: boolean }).polluted,
    ).toBeUndefined();
  });

  it("enforces input size, depth, node, and property limits", () => {
    const oversized = parseContract(`openapi: 3.1.0\nx: ${"x".repeat(100)}`, {
      limits: { maxInputBytes: 32 },
    });
    expect(oversized.diagnostics[0]?.code).toBe("INPUT_SIZE_LIMIT_EXCEEDED");
    expect(
      parseContract(minimalOpenApi({ "x-large": "x".repeat(100) }), {
        limits: { maxInputBytes: 64 },
      }).diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: "INPUT_SIZE_LIMIT_EXCEEDED" }),
    );

    const deep: JsonObject = minimalOpenApi();
    let cursor: Record<string, JsonObject> = deep as Record<string, JsonObject>;
    for (let index = 0; index < 10; index += 1) {
      const next: JsonObject = {};
      cursor["x-deep"] = next;
      cursor = next as Record<string, JsonObject>;
    }
    expect(
      parseContract(deep, { limits: { maxDepth: 6 } }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "DEPTH_LIMIT_EXCEEDED" }));

    expect(
      parseContract(minimalOpenApi(), { limits: { maxNodes: 5 } }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "NODE_LIMIT_EXCEEDED" }));

    expect(
      parseContract(minimalOpenApi({ "x-many": { a: 1, b: 2, c: 3 } }), {
        limits: { maxPropertiesPerObject: 2 },
      }).diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: "PROPERTY_LIMIT_EXCEEDED" }),
    );
  });

  it("bounds diagnostic output and reports truncation", () => {
    const source = minimalOpenApi();
    const webhooks = source["webhooks"] as Record<string, JsonValue>;
    for (let index = 0; index < 20; index += 1) {
      const operation = structuredClone(webhooks["event"]) as JsonObject;
      const post = operation["post"] as Record<string, JsonValue>;
      post["x-event-type"] = `event.${index}`;
      const requestBody = post["requestBody"] as JsonObject;
      const content = requestBody["content"] as JsonObject;
      const media = content["application/json"] as Record<string, JsonValue>;
      media["schema"] = {
        $ref: `https://invalid.example/${index}.json`,
      };
      webhooks[`event${index}`] = operation;
    }
    delete webhooks["event"];
    const result = validateContract(source, {
      limits: { maxDiagnostics: 4 },
    });

    expect(result.status).toBe("invalid");
    expect(result.diagnostics).toHaveLength(4);
    expect(result.diagnostics.at(-1)?.code).toBe("DIAGNOSTICS_TRUNCATED");

    const oneDiagnostic = validateContract(source, {
      limits: { maxDiagnostics: 1 },
    });
    expect(oneDiagnostic.status).toBe("invalid");
    expect(oneDiagnostic.diagnostics).toHaveLength(1);
  });

  it("enforces the shared local reference budget with memoization", () => {
    const source = minimalOpenApi({
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/Base" },
          B: { $ref: "#/components/schemas/Base" },
          Base: { type: "object" },
        },
      },
    });

    const webhooks = source["webhooks"] as JsonObject;
    const event = webhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = { $ref: "#/components/schemas/A" };
    expect(
      importContract(source, { limits: { maxReferences: 2 } }),
    ).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "REFERENCE_LIMIT_EXCEEDED" }),
      ]),
    });
  });

  it("bounds repeated-reference canonical expansion by bytes and nodes", () => {
    const properties: Record<string, JsonValue> = {};
    for (let index = 0; index < 80; index += 1) {
      properties[`field${index}`] = {
        $ref: "#/components/schemas/Chunk",
      };
    }
    const source = minimalOpenApi({
      components: {
        schemas: {
          Chunk: {
            description: "x".repeat(20_000),
            type: "string",
          },
          Root: { properties, type: "object" },
        },
      },
    });
    const webhooks = source["webhooks"] as JsonObject;
    const event = webhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = { $ref: "#/components/schemas/Root" };
    const encoded = JSON.stringify(source);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(32 * 1024);

    const started = performance.now();
    const bytesLimited = importContract(encoded, {
      limits: {
        maxOutputBytes: 128 * 1024,
        maxReferences: 500,
        maxValidationOperations: 100_000,
      },
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(bytesLimited.status).toBe("invalid");
    expect(bytesLimited.contract).toBeUndefined();
    expect(bytesLimited.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CANONICAL_OUTPUT_BUDGET_EXCEEDED",
      }),
    );

    const nodesLimited = importContract(encoded, {
      limits: {
        maxOutputBytes: 4 * 1024 * 1024,
        maxOutputNodes: 100,
        maxReferences: 500,
        maxValidationOperations: 100_000,
      },
    });
    expect(nodesLimited.status).toBe("invalid");
    expect(nodesLimited.contract).toBeUndefined();
    expect(nodesLimited.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CANONICAL_OUTPUT_BUDGET_EXCEEDED",
      }),
    );
  });

  it("shares one schema work budget across all component schemas", () => {
    const source = minimalOpenApi({
      components: {
        schemas: {
          First: { type: "object" },
          Second: { type: "object" },
        },
      },
    });
    const result = importContract(source, {
      limits: { maxValidationOperations: 1 },
    });
    expect(result.status).toBe("invalid");
    expect(
      result.diagnostics.filter(
        ({ code }) => code === "SCHEMA_VALIDATION_BUDGET_EXCEEDED",
      ),
    ).toHaveLength(1);
    expect(result.contract).toBeUndefined();
  });

  it("indexes many anchors once under shared timing and work budgets", () => {
    const anchoredSchemas: Record<string, JsonValue> = {};
    const rootProperties: Record<string, JsonValue> = {};
    for (let index = 0; index < 200; index += 1) {
      anchoredSchemas[`Anchor${index}`] = {
        $anchor: `anchor${index}`,
        type: "string",
      };
      rootProperties[`value${index}`] = { $ref: `#anchor${index}` };
    }
    anchoredSchemas["Root"] = {
      properties: rootProperties,
      type: "object",
    };
    const source = minimalOpenApi({
      components: { schemas: anchoredSchemas },
    });
    const webhooks = source["webhooks"] as JsonObject;
    const event = webhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = { $ref: "#/components/schemas/Root" };

    const started = performance.now();
    const result = importContract(source, {
      limits: {
        maxReferences: 500,
        maxValidationOperations: 10_000,
      },
    });
    expect(result.status).toBe("valid");
    // Shared CI runners can be CPU constrained; structural work limits below remain unchanged.
    const timingBudgetMilliseconds = process.env.CI === "true" ? 15_000 : 5_000;
    expect(performance.now() - started).toBeLessThan(timingBudgetMilliseconds);

    const limited = importContract(source, {
      limits: {
        maxReferences: 500,
        maxValidationOperations: 1,
      },
    });
    expect(limited.status).toBe("invalid");
    expect(
      limited.diagnostics.filter(
        ({ code }) => code === "SCHEMA_VALIDATION_BUDGET_EXCEEDED",
      ),
    ).toHaveLength(1);
  });

  it("rejects duplicate anchors deterministically", () => {
    const source = minimalOpenApi({
      components: {
        schemas: {
          First: { $anchor: "duplicate", type: "string" },
          Second: { $anchor: "duplicate", type: "number" },
        },
      },
    });
    const result = importContract(source);
    expect(result).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "SCHEMA_ANCHOR_DUPLICATE",
          details: {
            anchor: "duplicate",
            locations: [
              "/components/schemas/First",
              "/components/schemas/Second",
            ],
          },
        }),
      ]),
    });
  });

  it("fails fast on adversarial AsyncAPI source validation", () => {
    const source: Record<string, JsonValue> = {
      asyncapi: "3.0.0",
      info: { title: "Bounded", version: "1" },
    };
    for (let index = 0; index < 5_000; index += 1) {
      source[`invalid${index}`] = true;
    }
    const started = performance.now();
    const result = importContract(source);
    expect(result.status).toBe("invalid");
    expect(result.diagnostics.length).toBeLessThanOrEqual(8);
    expect(result.diagnostics[0]?.code).toBe("ASYNCAPI_DOCUMENT_INVALID");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("enforces event counts and rejects external schema documents", () => {
    const source = minimalOpenApi();
    const webhooks = source["webhooks"] as Record<string, JsonValue>;
    const second = structuredClone(webhooks["event"]) as JsonObject;
    const secondPost = second["post"] as Record<string, JsonValue>;
    secondPost["x-event-type"] = "second";
    webhooks["second"] = second;
    expect(
      importContract(source, { limits: { maxEvents: 1 } }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "EVENT_LIMIT_EXCEEDED" }));

    const remoteSource = minimalOpenApi();
    const remoteWebhooks = remoteSource["webhooks"] as JsonObject;
    const event = remoteWebhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = { $ref: "https://schemas.example.test/unsafe.json" };
    expect(importContract(remoteSource).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_EXTERNAL_REF_UNSUPPORTED",
      }),
    );
  });

  it("rejects credential-like examples unless clearly sanitized", () => {
    const source = minimalOpenApi();
    const webhooks = source["webhooks"] as JsonObject;
    const event = webhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = {
      properties: { api_key: { type: "string" } },
      type: "object",
    };
    media["example"] = { api_key: "sk_live_1234567890" };

    expect(importContract(source)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "EXAMPLE_POTENTIAL_SECRET" }),
      ]),
    });

    media["example"] = { api_key: "example-redacted-key" };
    expect(importContract(source).status).toBe("valid");
  });

  it("rejects object cycles without invoking serialization hooks", () => {
    const source = minimalOpenApi() as JsonObject & { self?: unknown };
    source.self = source;
    const parsed = parseContract(source as JsonObject);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CYCLIC_INPUT" }),
    );
  });

  it("rejects accessor properties without invoking getters", () => {
    const source = minimalOpenApi() as Record<string, unknown>;
    let accessed = false;
    Object.defineProperty(source, "danger", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("getter must not run");
      },
    });

    const parsed = parseContract(source as JsonObject);
    expect(accessed).toBe(false);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ACCESSOR_PROPERTY_DENIED" }),
    );
  });

  it("does not trust an input-spoofable parsed-contract discriminator", () => {
    const source = {
      ...minimalOpenApi(),
      kind: "parsed-contract",
    };
    expect(() => importContract(source)).not.toThrow();
    const parsed = parseContract(source);
    expect(parsed.format).toBe("openapi");
    expect(importContract(source)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "OPENAPI_DOCUMENT_INVALID" }),
      ]),
    });
  });

  it("snapshots and freezes caller objects and proxies before reuse", () => {
    const source = structuredClone(minimalOpenApi()) as Record<
      string,
      JsonValue
    >;
    const proxy = new Proxy(source, {});
    const parsed = parseContract(proxy as JsonObject, {
      limits: { maxStringBytes: 128 },
    });
    const first = canonicalizeContract(parsed);
    expect(first.contract).toBeDefined();
    expect(parsed.document).not.toBe(source);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.document)).toBe(true);
    expect(Object.isFrozen(parsed.sourceChecksum)).toBe(true);
    expect(
      typeof parsed.original === "string" || Object.isFrozen(parsed.original),
    ).toBe(true);

    const info = source["info"] as Record<string, JsonValue>;
    info["title"] = "x".repeat(10_000);
    const webhooks = source["webhooks"] as JsonObject;
    const event = webhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = { type: "string" };

    const second = canonicalizeContract(parsed);
    expect(second.contract?.checksum).toEqual(first.contract?.checksum);
    expect(second.contract?.eventTypes[0]?.versions[0]?.schema.value).toEqual({
      type: "object",
    });
    expect(
      (parsed.document?.["info"] as JsonObject | undefined)?.["title"],
    ).toBe("Security");
  });

  it("rejects non-string YAML keys and coercion collisions", () => {
    const result = parseContract(`
openapi: 3.1.0
info:
  title: Unsafe keys
  version: '1'
  200: numeric
  "200": string
webhooks: {}
`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "YAML_NON_STRING_MAPPING_KEY" }),
        expect.objectContaining({ code: "YAML_KEY_COERCION_COLLISION" }),
      ]),
    );
  });

  it("preserves but does not evaluate user regexes during AJV validation", () => {
    const source = minimalOpenApi();
    const webhooks = source["webhooks"] as JsonObject;
    const event = webhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = { pattern: "^(a|aa)+$", type: "string" };
    media["example"] = `${"a".repeat(20_000)}!`;

    const started = performance.now();
    const result = importContract(source);
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "REGEX_CONSTRAINTS_NOT_EVALUATED",
        }),
      ]),
    });
    expect(
      result.contract?.eventTypes[0]?.versions[0]?.schema.value,
    ).toMatchObject({ pattern: "^(a|aa)+$" });
    expect(elapsed).toBeLessThan(1_000);

    media["schema"] = {
      additionalProperties: false,
      patternProperties: {
        "^(a|aa)+$": { type: "string" },
      },
      type: "object",
    };
    media["example"] = { [`${"a".repeat(20_000)}!`]: 42 };
    const patternProperties = importContract(source);
    expect(patternProperties.status).toBe("partial");
    expect(
      patternProperties.contract?.eventTypes[0]?.versions[0]?.schema.value,
    ).toMatchObject({
      patternProperties: {
        "^(a|aa)+$": { type: "string" },
      },
    });

    media["schema"] = {
      properties: { id: { type: "string" } },
      type: "object",
    };
    media["example"] = { id: "ok" };
    expect(
      importContract(source, {
        limits: { maxValidationOperations: 1 },
      }),
    ).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "SCHEMA_VALIDATION_BUDGET_EXCEEDED",
        }),
      ]),
    });
  });

  it("skips quadratic uniqueItems work under a strict deadline", () => {
    const source = minimalOpenApi();
    const webhooks = source["webhooks"] as JsonObject;
    const event = webhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = {
      items: { type: "string" },
      type: "array",
      uniqueItems: true,
    };
    media["example"] = ["duplicate", "duplicate"];
    expect(importContract(source)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "EXAMPLE_SCHEMA_INVALID" }),
      ]),
    });

    media["schema"] = {
      items: {
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          payload: { type: "string" },
        },
        required: ["id", "payload"],
        type: "object",
      },
      type: "array",
      uniqueItems: true,
    };
    const examples = Array.from({ length: 2_985 }, (_, index) => ({
      id: index,
      payload: `${index}:${"x".repeat(56)}`,
    }));
    media["example"] = examples;
    const targetInputBytes = 249 * 1024;
    const unpadded = JSON.stringify(source);
    const padding = targetInputBytes - Buffer.byteLength(unpadded, "utf8");
    expect(padding).toBeGreaterThan(0);
    const lastExample = examples.at(-1);
    expect(lastExample).toBeDefined();
    if (lastExample === undefined) {
      throw new Error("uniqueItems timing probe requires an example");
    }
    lastExample.payload += "x".repeat(padding);
    const encoded = JSON.stringify(source);
    expect(Buffer.byteLength(encoded, "utf8")).toBe(targetInputBytes);

    const started = performance.now();
    const result = importContract(encoded, { formatHint: "json" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.status).toBe("partial");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "UNIQUE_ITEMS_NOT_EVALUATED" }),
    );
    expect(
      result.contract?.eventTypes[0]?.versions[0]?.schema.value,
    ).toMatchObject({ uniqueItems: true });
  });

  it("skips example instances whose node cost exceeds the work budget", () => {
    const source = minimalOpenApi();
    const webhooks = source["webhooks"] as JsonObject;
    const event = webhooks["event"] as JsonObject;
    const post = event["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = { items: { type: "string" }, type: "array" };
    media["example"] = Array.from({ length: 4_000 }, () => "value");

    const result = importContract(source, {
      limits: { maxValidationOperations: 6_000 },
    });
    expect(result.status).toBe("partial");
    expect(result.contract).toBeDefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "EXAMPLE_VALIDATION_BUDGET_EXCEEDED",
      }),
    );
  });
});
