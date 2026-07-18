// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";

import {
  CANONICAL_CONTRACT_JSON_SCHEMA,
  CANONICAL_EXPORT_JSON_SCHEMA,
  JSON_SCHEMA_2020_12_DIALECT,
  JSON_SCHEMA_DRAFT_07_DIALECT,
  OPENAPI_3_1_BASE_DIALECT,
  canonicalizeContract,
  importContract,
  isCanonicalContract,
  parseContract,
  validateContract,
  type CanonicalContract,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from "../src/index.js";

function openApi(schema: JsonSchema, extra: JsonObject = {}): JsonObject {
  return {
    ...extra,
    components: {
      schemas: {
        Order: schema,
      },
    },
    info: { title: "Orders", version: "1.0.0" },
    openapi: "3.1.0",
    webhooks: {
      "order.created": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                examples: {
                  valid: {
                    summary: "Created order",
                    value: { id: "ord_1", status: "created" },
                  },
                },
                schema: { $ref: "#/components/schemas/Order" },
              },
            },
          },
          responses: {
            "200": { description: "Accepted" },
          },
          summary: "Order created",
          "x-event-type": "order.created",
          "x-event-version": "1",
        },
      },
    },
  };
}

const orderSchema: JsonSchema = {
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    status: { enum: ["created", "paid"], type: "string" },
  },
  required: ["id", "status"],
  type: "object",
};

function requireContract(result: {
  readonly contract?: CanonicalContract;
}): CanonicalContract {
  expect(result.contract).toBeDefined();
  if (result.contract === undefined) {
    throw new Error("Expected canonical contract");
  }
  return result.contract;
}

describe("contract import corpus", () => {
  it("imports OpenAPI 3.1 JSON with local references and validated examples", () => {
    const result = importContract(openApi(orderSchema), {
      sourceUri: "repo://contracts/orders.json",
    });

    expect(result.status).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    const contract = requireContract(result);
    expect(isCanonicalContract(contract)).toBe(true);
    expect(contract.source.sourceUri).toBe("repo://contracts/orders.json");
    expect(contract.eventTypes).toHaveLength(1);
    expect(contract.eventTypes[0]?.externalName).toBe("order.created");
    expect(contract.eventTypes[0]?.versions[0]?.schema.dialect).toBe(
      OPENAPI_3_1_BASE_DIALECT,
    );
    expect(contract.eventTypes[0]?.versions[0]?.schema.value).toEqual(
      orderSchema,
    );
    expect(contract.eventTypes[0]?.versions[0]?.examples[0]?.name).toBe(
      "valid",
    );
    expect(result.export?.original.kind).toBe("document");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(CANONICAL_CONTRACT_JSON_SCHEMA);
    const validateExport = ajv.compile(CANONICAL_EXPORT_JSON_SCHEMA);
    expect(validateExport(result.export), validateExport.errors?.join()).toBe(
      true,
    );
    expect(
      canonicalizeContract(parseContract(openApi(orderSchema))).status,
    ).toBe("valid");
    expect(
      importContract(
        openApi({
          ...orderSchema,
          $schema: "https://spec.openapis.org/oas/3.1/dialect/base",
        }),
      ).status,
    ).toBe("valid");
  });

  it("imports OpenAPI YAML and reports source locations", () => {
    const source = `
openapi: 3.1.0
info:
  title: Orders
  version: 1.0.0
components:
  schemas:
    Order:
      type: object
      required: [id]
      properties:
        id:
          type: string
webhooks:
  order.created:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Order'
            example:
              id: ord_1
      responses:
        '200': { description: Accepted }
`;
    const result = importContract(source);

    expect(result.status).toBe("valid");
    expect(result.parsed.syntax).toBe("yaml");
    expect(result.parsed.locations["/webhooks/order.created"]).toBeDefined();
    expect(result.export?.original).toMatchObject({
      kind: "text",
      value: source,
    });
  });

  it("normalizes outbound AsyncAPI 2.6 and 3.0 messages only", () => {
    const asyncApi26 = `
asyncapi: 2.6.0
info:
  title: Orders
  version: 1.0.0
channels:
  orders:
    publish:
      message:
        name: inbound.only
        payload: { type: object }
    subscribe:
      message:
        name: order.created
        x-event-version: '1'
        payload:
          $schema: http://json-schema.org/draft-07/schema#
          type: object
          required: [id]
          properties:
            id: { type: string }
        examples:
          - name: valid
            payload: { id: ord_1 }
`;
    const asyncApi30: JsonObject = {
      asyncapi: "3.0.0",
      channels: {
        orders: {
          address: "orders",
          messages: {
            orderCreated: {
              $ref: "#/components/messages/orderCreated",
            },
            unused: {
              name: "unused.message",
              payload: { type: "object" },
            },
          },
        },
      },
      components: {
        messages: {
          orderCreated: {
            name: "order.created",
            payload: {
              properties: { id: { type: "string" } },
              required: ["id"],
              type: "object",
            },
            "x-event-version": "1",
          },
        },
      },
      info: { title: "Orders", version: "1.0.0" },
      operations: {
        receiveOrder: {
          action: "receive",
          channel: { $ref: "#/channels/orders" },
          messages: [{ $ref: "#/channels/orders/messages/unused" }],
        },
        sendOrderCreated: {
          action: "send",
          channel: { $ref: "#/channels/orders" },
          messages: [
            {
              $ref: "#/channels/orders/messages/orderCreated",
            },
          ],
        },
      },
    };

    const v26 = requireContract(importContract(asyncApi26));
    const v30 = requireContract(importContract(asyncApi30));
    expect(v26.eventTypes[0]?.externalName).toBe("order.created");
    expect(v30.eventTypes[0]?.externalName).toBe("order.created");
    expect(v26.eventTypes).toHaveLength(1);
    expect(v30.eventTypes).toHaveLength(1);
    expect(v26.eventTypes[0]?.versions[0]?.publicVersion).toBe("1");
    expect(v30.eventTypes[0]?.versions[0]?.publicVersion).toBe("1");
  });

  it("resolves draft-07 tuple items and additionalItems schemas", () => {
    const result = importContract({
      asyncapi: "2.6.0",
      channels: {
        tuple: {
          subscribe: {
            message: {
              name: "tuple.event",
              payload: {
                $schema: "http://json-schema.org/draft-07/schema#",
                additionalItems: {
                  $ref: "#/components/schemas/Extra",
                },
                items: [{ $ref: "#/components/schemas/Item" }],
                type: "array",
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Extra: { type: "number" },
          Item: { type: "string" },
        },
      },
      info: { title: "Tuples", version: "1" },
    });
    const schema = requireContract(result).eventTypes[0]?.versions[0]?.schema
      .value as JsonObject;
    expect(
      requireContract(result).eventTypes[0]?.versions[0]?.schema.dialect,
    ).toBe(JSON_SCHEMA_DRAFT_07_DIALECT);
    expect(schema["items"]).toEqual([{ type: "string" }]);
    expect(schema["additionalItems"]).toEqual({ type: "number" });
  });

  it("applies dialect-specific $ref sibling semantics", () => {
    const draft07 = importContract({
      asyncapi: "2.6.0",
      channels: {
        event: {
          subscribe: {
            message: {
              examples: [{ payload: "abc" }],
              name: "draft.event",
              payload: {
                $ref: "#/components/schemas/Base",
                $schema: JSON_SCHEMA_DRAFT_07_DIALECT,
                maxLength: 1,
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Base: { minLength: 3, type: "string" },
        },
      },
      info: { title: "Draft refs", version: "1" },
    });
    expect(draft07.status).toBe("valid");
    expect(
      requireContract(draft07).eventTypes[0]?.versions[0]?.schema.value,
    ).toEqual({ minLength: 3, type: "string" });

    const modern = openApi({ minLength: 3, type: "string" });
    const webhooks = modern["webhooks"] as JsonObject;
    const path = webhooks["order.created"] as JsonObject;
    const post = path["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = {
      $ref: "#/components/schemas/Order",
      maxLength: 1,
    };
    delete media["examples"];
    const modernResult = importContract(modern);
    expect(
      requireContract(modernResult).eventTypes[0]?.versions[0]?.schema.value,
    ).toMatchObject({
      allOf: [{ minLength: 3, type: "string" }, { maxLength: 1 }],
    });
  });

  it("maps the pinned AsyncAPI schemaFormat matrix to canonical dialects", () => {
    for (const schemaFormat of [
      undefined,
      "application/vnd.aai.asyncapi;version=2.6.0",
      "application/vnd.aai.asyncapi+json;version=2.6.0",
      "application/schema+json;version=draft-07",
      "http://json-schema.org/draft-07/schema#",
    ]) {
      const message: Record<string, JsonValue> = {
        name: "format.event",
        payload: {
          additionalItems: false,
          items: [{ type: "string" }],
          type: "array",
        },
      };
      if (schemaFormat !== undefined) message["schemaFormat"] = schemaFormat;
      const result = importContract({
        asyncapi: "2.6.0",
        channels: { event: { subscribe: { message } } },
        info: { title: "Formats", version: "1" },
      });
      expect(result.status).toBe("valid");
      expect(
        requireContract(result).eventTypes[0]?.versions[0]?.schema.dialect,
      ).toBe(JSON_SCHEMA_DRAFT_07_DIALECT);
    }

    const asyncApi30 = importContract({
      asyncapi: "3.0.0",
      channels: {
        event: {
          address: "event",
          messages: {
            event: {
              name: "format.event",
              payload: { type: "object" },
            },
          },
        },
      },
      info: { title: "Formats", version: "1" },
      operations: {
        send: {
          action: "send",
          channel: { $ref: "#/channels/event" },
        },
      },
    });
    expect(
      requireContract(asyncApi30).eventTypes[0]?.versions[0]?.schema.dialect,
    ).toBe(JSON_SCHEMA_2020_12_DIALECT);
  });

  it("rejects malformed input and invalid examples", () => {
    const malformed = parseContract('{"openapi": "3.1.0",');
    expect(malformed.ok).toBe(false);
    expect(malformed.diagnostics[0]).toMatchObject({
      code: "JSON_PARSE_ERROR",
      severity: "fatal",
    });

    const invalidExample = openApi({
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    });
    const media = (
      (
        (invalidExample["webhooks"] as JsonObject)[
          "order.created"
        ] as JsonObject
      )["post"] as JsonObject
    )["requestBody"] as JsonObject;
    const content = media["content"] as JsonObject;
    const applicationJson = content["application/json"] as Record<
      string,
      JsonValue
    >;
    applicationJson["examples"] = { invalid: { value: {} } };

    const result = importContract(invalidExample);
    expect(result.status).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "EXAMPLE_SCHEMA_INVALID" }),
    );

    const yamlInvalid = importContract(`
openapi: 3.1.0
info: { title: Invalid, version: '1' }
webhooks:
  event:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [id]
              properties:
                id: { type: string }
            example: {}
      responses:
        '200': { description: Accepted }
`);
    const diagnostic = yamlInvalid.diagnostics.find(
      ({ code }) => code === "EXAMPLE_SCHEMA_INVALID",
    );
    expect(diagnostic?.source?.start.line).toBeGreaterThan(0);
    expect(diagnostic?.source?.start.column).toBeGreaterThan(0);
  });

  it("rejects external and relative schema references explicitly", () => {
    const source = openApi({
      $ref: "https://schemas.example.test/order.json",
    });
    const denied = validateContract(source);
    expect(denied.status).toBe("invalid");
    expect(denied.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_EXTERNAL_REF_UNSUPPORTED" }),
    );

    const stillDenied = importContract(source);
    expect(stillDenied.status).toBe("invalid");
    expect(stillDenied.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_EXTERNAL_REF_UNSUPPORTED" }),
    );

    expect(importContract(openApi({ $ref: "./order.json" }))).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_RELATIVE_REF_UNSUPPORTED" }),
      ]),
    });
  });

  it("produces key-order-independent canonical checksums", () => {
    const first = JSON.stringify(openApi(orderSchema));
    const second = JSON.stringify({
      webhooks: openApi(orderSchema)["webhooks"],
      openapi: "3.1.0",
      info: { version: "1.0.0", title: "Orders" },
      components: openApi(orderSchema)["components"],
    });
    const firstResult = importContract(first);
    const secondResult = importContract(second);

    expect(firstResult.parsed.sourceChecksum).not.toEqual(
      secondResult.parsed.sourceChecksum,
    );
    expect(requireContract(firstResult).checksum).toEqual(
      requireContract(secondResult).checksum,
    );
    expect(JSON.stringify(requireContract(firstResult))).toBe(
      JSON.stringify(importContract(first).contract),
    );

    const yamlA = `
openapi: 3.1.0
info: { title: Orders, version: 1.0.0 }
webhooks:
  order.created:
    post:
      requestBody:
        content:
          application/json:
            schema: { type: object }
      responses:
        '200': { description: Accepted }
`;
    const yamlB = `
webhooks:
  order.created:
    post:
      requestBody:
        content:
          application/json:
            schema: { type: object }
      responses:
        '200': { description: Accepted }
info: { version: 1.0.0, title: Orders }
openapi: 3.1.0
`;
    expect(requireContract(importContract(yamlA)).checksum).toEqual(
      requireContract(importContract(yamlB)).checksum,
    );

    const reversedEnum: JsonSchema = {
      ...orderSchema,
      properties: {
        id: { type: "string" },
        status: { enum: ["paid", "created"], type: "string" },
      },
    };
    expect(
      requireContract(importContract(openApi(orderSchema))).checksum,
    ).toEqual(requireContract(importContract(openApi(reversedEnum))).checksum);
  });

  it("preserves JSON Schema reference sibling semantics with allOf", () => {
    const source = openApi({ ...orderSchema, additionalProperties: true });
    const webhooks = source["webhooks"] as JsonObject;
    const path = webhooks["order.created"] as JsonObject;
    const operation = path["post"] as JsonObject;
    const requestBody = operation["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = {
      $ref: "#/components/schemas/Order",
      properties: { source: { const: "api" } },
      required: ["source"],
      type: "object",
    };
    const examples = media["examples"] as JsonObject;
    const valid = examples["valid"] as Record<string, JsonValue>;
    valid["value"] = { id: "ord_1", source: "api", status: "created" };

    const schema = requireContract(importContract(source)).eventTypes[0]
      ?.versions[0]?.schema.value;
    expect(schema).toMatchObject({
      allOf: [
        expect.objectContaining({ type: "object" }),
        expect.objectContaining({ required: ["source"] }),
      ],
    });
  });

  it("preserves modern recursive ref siblings and ignores Draft-07 siblings before validation", () => {
    const modern = openApi({
      properties: {
        child: {
          $ref: "#/components/schemas/Order",
          description: "recursive child",
          minProperties: 1,
        },
      },
      type: "object",
    });
    const modernSchema = requireContract(importContract(modern)).eventTypes[0]
      ?.versions[0]?.schema.value as JsonObject;
    const modernProperties = modernSchema["properties"] as JsonObject;
    expect(modernProperties["child"]).toEqual({
      allOf: [
        { $ref: "#" },
        { description: "recursive child", minProperties: 1 },
      ],
    });

    const draft07 = importContract({
      asyncapi: "2.6.0",
      channels: {
        event: {
          subscribe: {
            message: {
              name: "recursive.draft7",
              payload: { $ref: "#/components/schemas/Node" },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            properties: {
              child: {
                $id: "ignored relative id",
                $ref: "#/components/schemas/Node",
                minProperties: 1,
              },
            },
            type: "object",
          },
        },
      },
      info: { title: "Recursive Draft-07", version: "1" },
    });
    expect(draft07.status).toBe("valid");
    const draftSchema = requireContract(draft07).eventTypes[0]?.versions[0]
      ?.schema.value as JsonObject;
    const draftProperties = draftSchema["properties"] as JsonObject;
    expect(draftProperties["child"]).toEqual({ $ref: "#" });
  });

  it("validates OpenAPI roots, responses, and JSON media requirements before extraction", () => {
    const missingInfo = importContract({
      openapi: "3.1.0",
      webhooks: {},
    });
    expect(missingInfo).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "OPENAPI_DOCUMENT_INVALID" }),
      ]),
    });

    const missingResponses = openApi(orderSchema);
    const webhook = (missingResponses["webhooks"] as JsonObject)[
      "order.created"
    ] as JsonObject;
    const post = webhook["post"] as Record<string, JsonValue>;
    delete post["responses"];
    expect(importContract(missingResponses)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "OPENAPI_WEBHOOK_RESPONSES_MISSING",
          pointer: expect.stringContaining("responses"),
        }),
      ]),
    });

    const xmlOnly = openApi(orderSchema);
    const xmlWebhook = (xmlOnly["webhooks"] as JsonObject)[
      "order.created"
    ] as JsonObject;
    const xmlPost = xmlWebhook["post"] as JsonObject;
    const requestBody = xmlPost["requestBody"] as JsonObject;
    const content = requestBody["content"] as Record<string, JsonValue>;
    content["application/xml"] = content["application/json"] as JsonValue;
    delete content["application/json"];
    expect(importContract(xmlOnly)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "OPENAPI_JSON_PAYLOAD_MISSING" }),
      ]),
    });
  });

  it("preserves recursive local schemas and ignores opaque reference-shaped data", () => {
    const recursive = openApi({
      properties: {
        child: { $ref: "#/components/schemas/Order" },
        id: { type: "string" },
      },
      required: ["id"],
      type: "object",
    });
    const recursiveWebhook = (recursive["webhooks"] as JsonObject)[
      "order.created"
    ] as JsonObject;
    const recursivePost = recursiveWebhook["post"] as JsonObject;
    const requestBody = recursivePost["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["examples"] = {
      opaque: {
        value: { $ref: "https://opaque.example/not-a-schema-ref", id: "1" },
      },
    };
    (recursive as Record<string, JsonValue>)["x-opaque"] = {
      $ref: "./also-not-a-reference",
    };

    const result = importContract(recursive);
    const schema = requireContract(result).eventTypes[0]?.versions[0]?.schema
      .value as JsonObject;
    const properties = schema["properties"] as JsonObject;
    expect(properties["child"]).toEqual({ $ref: "#" });
    expect(
      requireContract(result).eventTypes[0]?.versions[0]?.examples[0]?.value,
    ).toEqual({
      $ref: "https://opaque.example/not-a-schema-ref",
      id: "1",
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("allows document refs only to explicitly indexed schema locations", () => {
    const source = openApi(orderSchema);
    const components = source["components"] as Record<string, JsonValue>;
    components["examples"] = {
      Fake: { value: { type: "string" } },
    };
    components["headers"] = {
      Fake: { schema: { type: "string" } },
    };
    (source as Record<string, JsonValue>)["x-fake-schema"] = {
      type: "string",
    };

    const setPayloadRef = (document: JsonObject, reference: string): void => {
      const webhooks = document["webhooks"] as JsonObject;
      const webhook = webhooks["order.created"] as JsonObject;
      const post = webhook["post"] as JsonObject;
      const requestBody = post["requestBody"] as JsonObject;
      const content = requestBody["content"] as JsonObject;
      const media = content["application/json"] as Record<string, JsonValue>;
      media["schema"] = { $ref: reference };
    };

    for (const reference of [
      "#/components/examples/Fake/value",
      "#/components/headers/Fake",
      "#/components/headers/Fake/schema",
      "#/webhooks/order.created/post",
      "#/x-fake-schema",
    ]) {
      const adversarial = structuredClone(source) as JsonObject;
      setPayloadRef(adversarial, reference);
      expect(importContract(adversarial)).toMatchObject({
        status: "invalid",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "SCHEMA_REF_NOT_FOUND" }),
        ]),
      });
    }

    const valid = structuredClone(source) as JsonObject;
    setPayloadRef(valid, "#/components/schemas/Order");
    const result = importContract(valid);
    expect(result.status).toBe("valid");
    expect(result.export?.original).toMatchObject({
      kind: "document",
      value: expect.objectContaining({
        "x-fake-schema": { type: "string" },
      }),
    });
  });

  it("enforces typed OpenAPI path-item, request-body, and example references", () => {
    const source = openApi(orderSchema);
    const originalWebhooks = source["webhooks"] as JsonObject;
    const originalPath = originalWebhooks["order.created"] as JsonObject;
    const originalPost = originalPath["post"] as JsonObject;
    const originalRequestBody = originalPost["requestBody"] as JsonObject;
    const components = source["components"] as Record<string, JsonValue>;
    components["examples"] = {
      Good: { value: { id: "ord_1", status: "created" } },
      Trap: {
        value: {
          content: {
            "application/json": { schema: { type: "object" } },
          },
          pathItem: originalPath,
          post: originalPost,
          requestBody: originalRequestBody,
        },
      },
    };
    components["requestBodies"] = {
      Body: structuredClone(originalRequestBody),
    };
    const requestBodies = components["requestBodies"] as JsonObject;
    const body = requestBodies["Body"] as JsonObject;
    (body as Record<string, JsonValue>)["x-holder"] = {
      requestBody: originalRequestBody,
    };
    const content = body["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["examples"] = {
      good: { $ref: "#/components/examples/Good" },
    };
    components["pathItems"] = {
      Good: {
        post: {
          requestBody: { $ref: "#/components/requestBodies/Body" },
          responses: { "200": { description: "Accepted" } },
          "x-event-type": "order.created",
        },
      },
      Wrapper: {
        "x-holder": {
          pathItem: originalPath,
          requestBody: originalRequestBody,
        },
      },
    };
    (source as Record<string, JsonValue>)["webhooks"] = {
      "order.created": { $ref: "#/components/pathItems/Good" },
    };
    (source as Record<string, JsonValue>)["x-path-item"] = originalPath;
    (source as Record<string, JsonValue>)["x-request-body"] =
      originalRequestBody;

    const positive = importContract(source);
    expect(positive.status).toBe("valid");
    expect(
      requireContract(positive).eventTypes[0]?.versions[0]?.examples[0]?.value,
    ).toEqual({ id: "ord_1", status: "created" });
    expect(positive.export?.original).toMatchObject({
      kind: "document",
      value: expect.objectContaining({
        "x-path-item": expect.any(Object),
        "x-request-body": expect.any(Object),
      }),
    });

    for (const [kind, reference] of [
      ["path", "#/components/examples/Trap/value"],
      ["path", "#/x-path-item"],
      ["path", "#/components/pathItems/Wrapper/x-holder/pathItem"],
      ["body", "#/components/examples/Trap/value"],
      ["body", "#/x-request-body"],
      ["body", "#/components/pathItems/Wrapper/x-holder/requestBody"],
      ["body", "#/components/requestBodies/Body/x-holder/requestBody"],
      ["body", "#/components/examples/Trap/value/requestBody"],
    ] as const) {
      const adversarial = structuredClone(source) as JsonObject;
      if (kind === "path") {
        (adversarial as Record<string, JsonValue>)["webhooks"] = {
          "order.created": { $ref: reference },
        };
      } else {
        const components = adversarial["components"] as JsonObject;
        const pathItems = components["pathItems"] as JsonObject;
        const path = pathItems["Good"] as JsonObject;
        const post = path["post"] as Record<string, JsonValue>;
        post["requestBody"] = { $ref: reference };
      }
      expect(importContract(adversarial)).toMatchObject({
        status: "invalid",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "REF_TARGET_KIND_MISMATCH" }),
        ]),
      });
    }
  });

  it("indexes recognized AsyncAPI payload schemas but not opaque message data", () => {
    const source: JsonObject = {
      asyncapi: "3.0.0",
      channels: {
        events: {
          address: "events",
          messages: {
            consumer: { $ref: "#/components/messages/consumer" },
          },
        },
      },
      components: {
        messages: {
          consumer: {
            name: "consumer",
            payload: { $ref: "#/components/messages/source/payload" },
          },
          source: {
            examples: [{ payload: { type: "number" } }],
            name: "source",
            payload: { type: "string" },
            "x-fake-schema": { type: "boolean" },
          },
        },
      },
      info: { title: "Indexed", version: "1" },
      operations: {
        send: {
          action: "send",
          channel: { $ref: "#/channels/events" },
        },
      },
    };
    const positive = importContract(source);
    expect(positive.status).toBe("valid");
    expect(positive.export?.original).toMatchObject({
      kind: "document",
      value: {
        components: {
          messages: {
            source: {
              "x-fake-schema": { type: "boolean" },
            },
          },
        },
      },
    });

    for (const reference of [
      "#/components/messages/source/examples/0/payload",
      "#/components/messages/source/x-fake-schema",
    ]) {
      const adversarial = structuredClone(source) as JsonObject;
      const components = adversarial["components"] as JsonObject;
      const messages = components["messages"] as JsonObject;
      const consumer = messages["consumer"] as JsonObject;
      (consumer as Record<string, JsonValue>)["payload"] = {
        $ref: reference,
      };
      expect(importContract(adversarial)).toMatchObject({
        status: "invalid",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "SCHEMA_REF_NOT_FOUND" }),
        ]),
      });
    }
  });

  it("rejects typed AsyncAPI wrapper refs into examples and extensions", () => {
    const source: JsonObject = {
      asyncapi: "3.0.0",
      channels: {
        events: {
          address: "events",
          messages: {
            inline: {
              name: "inline",
              payload: { type: "object" },
              "x-holder": {
                message: {
                  name: "nested",
                  payload: { type: "object" },
                },
              },
            },
            source: { $ref: "#/components/messages/source" },
          },
        },
        wrapper: {
          address: "wrapper",
          messages: {},
          "x-holder": {
            channel: { address: "nested", messages: {} },
          },
        },
      },
      components: {
        channels: {
          Wrapper: {
            address: "wrapper",
            messages: {},
            "x-holder": {
              channel: { address: "nested", messages: {} },
            },
          },
        },
        messages: {
          source: {
            examples: [
              {
                payload: {
                  properties: { id: { type: "string" } },
                  type: "object",
                },
              },
            ],
            name: "source",
            payload: { type: "object" },
            "x-holder": {
              message: {
                name: "nested",
                payload: { type: "object" },
              },
            },
          },
        },
        operations: {
          Wrapper: {
            action: "receive",
            channel: { $ref: "#/channels/events" },
            "x-holder": {
              operation: {
                action: "send",
                channel: { $ref: "#/channels/events" },
              },
            },
          },
        },
      },
      info: { title: "Typed references", version: "1" },
      operations: {
        send: {
          action: "send",
          channel: { $ref: "#/channels/events" },
        },
        wrapper: {
          action: "receive",
          channel: { $ref: "#/channels/events" },
          "x-holder": {
            operation: {
              action: "send",
              channel: { $ref: "#/channels/events" },
            },
          },
        },
      },
      "x-fake-channel": {
        address: "fake",
        messages: {},
      },
      "x-fake-message": {
        name: "fake",
        payload: { type: "object" },
      },
      "x-fake-operation": {
        action: "send",
        channel: { $ref: "#/channels/events" },
      },
    };
    const positive = importContract(source);
    expect(positive.status).toBe("valid");
    expect(positive.export?.original).toMatchObject({
      kind: "document",
      value: expect.objectContaining({
        "x-fake-message": expect.any(Object),
      }),
    });

    for (const [kind, reference] of [
      ["message", "#/components/messages/source/examples/0"],
      ["message", "#/x-fake-message"],
      ["message", "#/components/messages/source/x-holder/message"],
      ["message", "#/channels/events/messages/inline/x-holder/message"],
      ["channel", "#/x-fake-channel"],
      ["channel", "#/channels/wrapper/x-holder/channel"],
      ["channel", "#/components/channels/Wrapper/x-holder/channel"],
      ["operation", "#/x-fake-operation"],
      ["operation", "#/operations/wrapper/x-holder/operation"],
      ["operation", "#/components/operations/Wrapper/x-holder/operation"],
    ] as const) {
      const adversarial = structuredClone(source) as JsonObject;
      if (kind === "message") {
        const channels = adversarial["channels"] as JsonObject;
        const channel = channels["events"] as JsonObject;
        const messages = channel["messages"] as Record<string, JsonValue>;
        messages["source"] = { $ref: reference };
      } else if (kind === "channel") {
        const operations = adversarial["operations"] as JsonObject;
        const send = operations["send"] as Record<string, JsonValue>;
        send["channel"] = { $ref: reference };
      } else {
        const operations = adversarial["operations"] as Record<
          string,
          JsonValue
        >;
        operations["send"] = { $ref: reference };
      }
      expect(importContract(adversarial)).toMatchObject({
        status: "invalid",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "REF_TARGET_KIND_MISMATCH" }),
        ]),
      });
    }
  });

  it("resolves schema-only anchors and preserves every reference sibling", () => {
    const source = openApi({
      $anchor: "order",
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    });
    (source as Record<string, JsonValue>)["x-opaque"] = {
      $anchor: "order",
      type: "string",
    };
    const webhook = (source["webhooks"] as JsonObject)[
      "order.created"
    ] as JsonObject;
    const post = webhook["post"] as JsonObject;
    const requestBody = post["requestBody"] as JsonObject;
    const content = requestBody["content"] as JsonObject;
    const media = content["application/json"] as Record<string, JsonValue>;
    media["schema"] = {
      $ref: "#order",
      default: { id: "default" },
      description: "Sibling annotation",
      readOnly: true,
    };
    media["example"] = { $anchor: "order", id: "value" };

    const result = importContract(source);
    const schema =
      requireContract(result).eventTypes[0]?.versions[0]?.schema.value;
    expect(schema).toMatchObject({
      allOf: [
        expect.objectContaining({
          $anchor: "order",
          type: "object",
        }),
        {
          default: { id: "default" },
          description: "Sibling annotation",
          readOnly: true,
        },
      ],
    });
  });

  it("enforces anchor and identifier syntax and resource boundaries", () => {
    expect(importContract(openApi({ $id: "#", type: "object" })).status).toBe(
      "valid",
    );

    for (const [schema, code] of [
      [{ $anchor: "bad anchor", type: "object" }, "SCHEMA_ANCHOR_INVALID"],
      [{ $id: "#order", type: "object" }, "SCHEMA_ID_FRAGMENT_UNSUPPORTED"],
      [
        { $id: "relative/order", type: "object" },
        "SCHEMA_ID_RELATIVE_UNSUPPORTED",
      ],
      [{ $id: "bad id", type: "object" }, "SCHEMA_ID_INVALID"],
      [
        { $id: "https://schemas.example.test/order", type: "object" },
        "SCHEMA_ID_BASE_UNSUPPORTED",
      ],
    ] as const) {
      expect(importContract(openApi(schema as JsonSchema))).toMatchObject({
        status: "invalid",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code }),
        ]),
      });
    }
  });

  it("keeps method-derived event identities stable as methods are added", () => {
    const operation = {
      requestBody: {
        content: {
          "application/json": { schema: { type: "object" } },
        },
      },
      responses: { "200": { description: "Accepted" } },
    };
    const baseline = importContract({
      info: { title: "Methods", version: "1" },
      openapi: "3.1.0",
      webhooks: { event: { put: operation } },
    });
    const expanded = importContract({
      info: { title: "Methods", version: "1" },
      openapi: "3.1.0",
      webhooks: { event: { post: operation, put: operation } },
    });
    const before = requireContract(baseline).eventTypes.find(
      ({ externalName }) => externalName === "event.put",
    );
    const after = requireContract(expanded).eventTypes.find(
      ({ externalName }) => externalName === "event.put",
    );
    expect(before?.id).toBe(after?.id);
    expect(
      requireContract(expanded).eventTypes.map(
        ({ externalName }) => externalName,
      ),
    ).toEqual(["event.post", "event.put"]);
  });

  it("deduplicates only fully identical event versions", () => {
    const operation = {
      requestBody: {
        content: {
          "application/json": { schema: { type: "object" } },
        },
      },
      responses: { "200": { description: "Accepted" } },
      summary: "Shared event",
      "x-event-id": "shared-source",
      "x-event-type": "shared.event",
      "x-event-version": "1",
      "x-signature-profile": {
        name: "standard-webhooks",
        version: "1",
      },
    };
    const identical = importContract({
      info: { title: "Duplicates", version: "1" },
      openapi: "3.1.0",
      webhooks: {
        event: {
          post: operation,
          put: structuredClone(operation),
        },
      },
    });
    expect(identical.status).toBe("valid");
    expect(requireContract(identical).eventTypes).toHaveLength(1);
    expect(requireContract(identical).eventTypes[0]?.versions).toHaveLength(1);

    const conflictingOperation = structuredClone(operation);
    conflictingOperation["x-signature-profile"] = {
      name: "custom-signature",
      version: "2",
    };
    const conflicting = importContract({
      info: { title: "Duplicates", version: "1" },
      openapi: "3.1.0",
      webhooks: {
        event: {
          post: operation,
          put: conflictingOperation,
        },
      },
    });
    expect(conflicting).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "DUPLICATE_EVENT_VERSION_CONFLICT",
          details: expect.objectContaining({
            differences: expect.arrayContaining(["signatureProfile"]),
            event: "shared.event",
            version: "1",
          }),
        }),
      ]),
    });
  });

  it("rejects empty canonical identity extensions instead of falling back", () => {
    for (const [field, value] of [
      ["x-event-type", ""],
      ["x-event-version", "   "],
      ["x-event-id", ""],
    ] as const) {
      const source = openApi(orderSchema);
      const webhooks = source["webhooks"] as JsonObject;
      const path = webhooks["order.created"] as JsonObject;
      const post = path["post"] as Record<string, JsonValue>;
      post[field] = value;
      const result = importContract(source);
      expect(result).toMatchObject({
        status: "invalid",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "CANONICAL_EXTENSION_VALUE_INVALID",
          }),
        ]),
      });
      expect(result.contract).toBeUndefined();
    }

    const contractId = openApi(orderSchema);
    (contractId as Record<string, JsonValue>)["x-contract-id"] = " ";
    expect(importContract(contractId)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CANONICAL_EXTENSION_VALUE_INVALID",
          pointer: "/x-contract-id",
        }),
      ]),
    });
  });

  it("rejects empty AsyncAPI identities and validates final canonical output", () => {
    const source: JsonObject = {
      asyncapi: "3.0.0",
      channels: {
        events: {
          address: "events",
          messages: {
            event: { $ref: "#/components/messages/event" },
          },
        },
      },
      components: {
        messages: {
          event: {
            name: "event",
            payload: { type: "object" },
            "x-event-version": " ",
          },
        },
      },
      info: { title: "Async", version: "1" },
      operations: {
        send: {
          action: "send",
          channel: { $ref: "#/channels/events" },
        },
      },
    };
    expect(importContract(source)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CANONICAL_EXTENSION_VALUE_INVALID",
        }),
      ]),
    });

    const signature = openApi(orderSchema);
    (signature as Record<string, JsonValue>)["x-signature-profile"] = {
      name: "",
    };
    expect(importContract(signature)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CANONICAL_CONTRACT_SCHEMA_INVALID",
        }),
      ]),
    });
    expect(validateContract(signature)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CANONICAL_CONTRACT_SCHEMA_INVALID",
        }),
      ]),
    });
  });

  it("rejects malformed AsyncAPI roots and non-JSON schema formats", () => {
    expect(
      importContract({
        asyncapi: "2.6.0",
        channels: { event: {} },
        info: { version: "1" },
      }),
    ).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "ASYNCAPI_DOCUMENT_INVALID" }),
      ]),
    });

    expect(
      importContract({
        asyncapi: "2.6.0",
        channels: {
          event: {
            subscribe: {
              message: {
                name: "event",
                payload: { type: "object" },
                schemaFormat: "application/vnd.apache.avro+json",
              },
            },
          },
        },
        info: { title: "Async", version: "1" },
      }),
    ).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ASYNCAPI_SCHEMA_FORMAT_UNSUPPORTED",
        }),
      ]),
    });

    expect(
      importContract({
        asyncapi: "3.0.0",
        channels: { event: { address: "event", messages: {} } },
        info: { title: "Async", version: "1" },
        operations: {
          send: {
            action: "send",
            channel: { $ref: "#/channels/event" },
            messages: [],
          },
        },
      }),
    ).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "ASYNCAPI_CHANNEL_MESSAGES_MISSING" }),
      ]),
    });
  });

  it("uses official AsyncAPI schemas and enforces send-message subsets", () => {
    const messages = {
      first: {
        name: "event.first",
        payload: { type: "object" },
      },
      second: {
        name: "event.second",
        payload: { type: "object" },
      },
    };
    const base: JsonObject = {
      asyncapi: "3.0.0",
      channels: {
        events: {
          address: "events",
          messages: {
            first: { $ref: "#/components/messages/first" },
            second: { $ref: "#/components/messages/second" },
          },
        },
      },
      components: { messages },
      info: { title: "Async", version: "1" },
      operations: {
        send: {
          action: "send",
          channel: { $ref: "#/channels/events" },
        },
      },
    };

    expect(requireContract(importContract(base)).eventTypes).toHaveLength(2);

    const subset = structuredClone(base) as JsonObject;
    const subsetOperations = subset["operations"] as JsonObject;
    const subsetSend = subsetOperations["send"] as Record<string, JsonValue>;
    subsetSend["messages"] = [{ $ref: "#/channels/events/messages/first" }];
    expect(requireContract(importContract(subset)).eventTypes).toHaveLength(1);

    const invalidSubset = structuredClone(base) as JsonObject;
    const invalidOperations = invalidSubset["operations"] as JsonObject;
    const invalidSend = invalidOperations["send"] as Record<string, JsonValue>;
    invalidSend["messages"] = [{ $ref: "#/components/messages/second" }];
    const invalidChannels = invalidSubset["channels"] as JsonObject;
    const invalidChannel = invalidChannels["events"] as JsonObject;
    const invalidMessages = invalidChannel["messages"] as Record<
      string,
      JsonValue
    >;
    delete invalidMessages["second"];
    expect(importContract(invalidSubset)).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ASYNCAPI_SEND_MESSAGE_NOT_IN_CHANNEL",
        }),
      ]),
    });

    const referenced: JsonObject = {
      asyncapi: "3.0.0",
      channels: {
        events: { $ref: "#/components/channels/events" },
      },
      components: {
        channels: {
          events: {
            address: "events",
            messages: {
              first: { $ref: "#/components/messages/first" },
            },
          },
        },
        messages: { first: messages.first },
        operations: {
          send: {
            action: "send",
            channel: { $ref: "#/channels/events" },
          },
        },
      },
      info: { title: "Async", version: "1" },
      operations: {
        send: { $ref: "#/components/operations/send" },
      },
    };
    expect(requireContract(importContract(referenced)).eventTypes).toHaveLength(
      1,
    );

    expect(
      importContract({ ...base, unsupportedRootField: true }),
    ).toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ASYNCAPI_DOCUMENT_INVALID",
          pointer: "/unsupportedRootField",
        }),
      ]),
    });
  });

  it("marks unsupported versions as explicit partial imports", () => {
    const result = validateContract({
      info: { title: "Old", version: "1" },
      openapi: "3.0.3",
      paths: {},
    });
    expect(result.status).toBe("partial");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_SOURCE_VERSION",
        pointer: "/openapi",
      }),
    );

    expect(
      validateContract({
        asyncapi: "3.1.0",
        channels: {},
        info: { title: "Future", version: "1" },
      }),
    ).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "UNSUPPORTED_SOURCE_VERSION" }),
      ]),
    });
  });
});
