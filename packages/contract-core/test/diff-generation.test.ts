// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { Ajv2020 } from "ajv/dist/2020.js";

import {
  diffContracts,
  generateFixture,
  generateTypeScript,
  importContract,
  type CanonicalContract,
  type CanonicalEventVersion,
  type JsonObject,
  type JsonSchema,
} from "../src/index.js";

function contract(
  schema: JsonSchema,
  options: {
    readonly description?: string;
    readonly eventName?: string;
    readonly extension?: string;
    readonly publicVersion?: string;
    readonly signature?: JsonObject | boolean;
  } = {},
): CanonicalContract {
  const source: JsonObject = {
    info: { title: "Example", version: options.publicVersion ?? "1" },
    openapi: "3.1.0",
    webhooks: {
      [options.eventName ?? "event.created"]: {
        post: {
          ...(options.description === undefined
            ? {}
            : { description: options.description }),
          requestBody: {
            content: {
              "application/json": {
                schema,
              },
            },
          },
          responses: {
            "200": { description: "Accepted" },
          },
          summary: "Created",
          "x-event-type": options.eventName ?? "event.created",
        },
      },
    },
    ...(options.signature === undefined
      ? {}
      : { "x-standard-webhooks": options.signature }),
    ...(options.extension === undefined
      ? {}
      : { "x-vendor-behavior": options.extension }),
  };
  const result = importContract(source);
  if (result.contract === undefined) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.contract;
}

const baseSchema: JsonSchema = {
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    state: { enum: ["new", "paid"], type: "string" },
  },
  required: ["id"],
  type: "object",
};

function compileWitness(code: string, witness: string): readonly string[] {
  const fileName = "generated-witness.ts";
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const source = ts.createSourceFile(
    fileName,
    `${code}\n${witness}\n`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (candidate) =>
    candidate === fileName || ts.sys.fileExists(candidate);
  host.readFile = (candidate) =>
    candidate === fileName ? source.text : ts.sys.readFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreate) =>
    candidate === fileName
      ? source
      : getSourceFile(candidate, languageVersion, onError, shouldCreate);
  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

function ajvAccepts(schema: JsonSchema, value: unknown): boolean {
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
  });
  return ajv.compile(schema)(value) as boolean;
}

describe("semantic contract diff", () => {
  it("classifies compatible optional fields and enum widening", () => {
    const next: JsonSchema = {
      ...baseSchema,
      properties: {
        ...((baseSchema as JsonObject)["properties"] as JsonObject),
        note: { type: "string" },
        state: { enum: ["new", "paid", "shipped"], type: "string" },
      },
    };
    const result = diffContracts(contract(baseSchema), contract(next));

    expect(result.status).toBe("compatible");
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OPTIONAL_PROPERTY_ADDED" }),
        expect.objectContaining({ code: "ENUM_WIDENED" }),
      ]),
    );
  });

  it("classifies event removal and required-property widening correctly", () => {
    const optionalId: JsonSchema = {
      ...baseSchema,
      required: [],
    };
    expect(
      diffContracts(contract(baseSchema), contract(optionalId)),
    ).toMatchObject({
      status: "compatible",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "PROPERTY_BECAME_OPTIONAL" }),
      ]),
    });

    expect(
      diffContracts(
        contract(baseSchema),
        contract(baseSchema, { eventName: "event.renamed" }),
      ),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "EVENT_REMOVED" }),
        expect.objectContaining({ code: "EVENT_ADDED" }),
      ]),
    });
  });

  it("classifies docs-only, signature, narrowing, and unknown changes", () => {
    expect(
      diffContracts(
        contract(baseSchema, { description: "Before" }),
        contract(baseSchema, { description: "After" }),
      ).status,
    ).toBe("docs-only");

    expect(
      diffContracts(
        contract(baseSchema, { signature: true }),
        contract(baseSchema, {
          signature: { algorithm: "ed25519", name: "custom" },
        }),
      ).status,
    ).toBe("breaking");

    const narrowed: JsonSchema = {
      ...baseSchema,
      properties: {
        ...((baseSchema as JsonObject)["properties"] as JsonObject),
        state: { enum: ["new"], type: "string" },
      },
    };
    expect(
      diffContracts(contract(baseSchema), contract(narrowed)),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "ENUM_NARROWED" }),
      ]),
    });

    const unknown: JsonSchema = {
      ...baseSchema,
      not: { required: ["legacy"] },
    };
    expect(
      diffContracts(contract(baseSchema), contract(unknown)),
    ).toMatchObject({
      status: "unknown",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_DIFF" }),
      ]),
    });
  });

  it("compares behavior, not identity, across public version transitions", () => {
    const previous = contract(baseSchema, { publicVersion: "1" });
    const next = contract(baseSchema, { publicVersion: "2" });
    expect(diffContracts(previous, next)).toMatchObject({
      status: "compatible",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "EVENT_VERSION_ADDED" }),
      ]),
    });
    expect(
      diffContracts(previous, next).changes.some(
        ({ code }) => code === "EVENT_VERSION_ID_CHANGED",
      ),
    ).toBe(false);

    const event = previous.eventTypes[0];
    const version = event?.versions[0];
    if (event === undefined || version === undefined) {
      throw new Error("Expected event version");
    }
    const conflicting: CanonicalContract = {
      ...previous,
      eventTypes: [
        {
          ...event,
          versions: [{ ...version, id: "conflicting-version-id" }],
        },
      ],
    };
    expect(diffContracts(previous, conflicting)).toMatchObject({
      status: "unknown",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "EVENT_VERSION_ID_CHANGED" }),
      ]),
    });

    const version18 = contract(baseSchema, { publicVersion: "1.8" });
    const version19 = contract(baseSchema, { publicVersion: "1.9" });
    const version110 = contract(baseSchema, { publicVersion: "1.10" });
    const event18 = version18.eventTypes[0];
    const event19 = version19.eventTypes[0];
    if (event18 === undefined || event19 === undefined) {
      throw new Error("Expected versioned events");
    }
    const ambiguousPrevious: CanonicalContract = {
      ...version18,
      eventTypes: [
        {
          ...event18,
          versions: [
            ...(event18.versions as readonly [CanonicalEventVersion]),
            ...(event19.versions as readonly [CanonicalEventVersion]),
          ],
        },
      ],
    };
    expect(diffContracts(ambiguousPrevious, version110)).toMatchObject({
      status: "unknown",
      changes: expect.arrayContaining([
        expect.objectContaining({
          code: "VERSION_COMPARISON_AMBIGUOUS",
          previous: ["1.8", "1.9"],
          next: ["1.10"],
        }),
      ]),
    });
  });

  it("distinguishes type narrowing from widening", () => {
    const wide: JsonSchema = {
      properties: {
        value: { type: ["number", "string"] },
      },
      required: ["value"],
      type: "object",
    };
    const narrow: JsonSchema = {
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
      type: "object",
    };

    expect(diffContracts(contract(wide), contract(narrow))).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "TYPE_NARROWED" }),
      ]),
    });
    expect(diffContracts(contract(narrow), contract(wide))).toMatchObject({
      status: "compatible",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "TYPE_WIDENED" }),
      ]),
    });
  });

  it("treats integer as a subtype of number", () => {
    const integerSchema: JsonSchema = { type: "integer" };
    const numberSchema: JsonSchema = { type: "number" };
    expect(
      diffContracts(contract(integerSchema), contract(numberSchema)),
    ).toMatchObject({
      status: "compatible",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "TYPE_WIDENED" }),
      ]),
    });
    expect(
      diffContracts(contract(numberSchema), contract(integerSchema)),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "TYPE_NARROWED" }),
      ]),
    });
  });

  it("handles open-object additions and set-valued keywords conservatively", () => {
    const openBefore: JsonSchema = {
      properties: { id: { type: "string" } },
      type: "object",
    };
    const constrainedOptional: JsonSchema = {
      properties: {
        id: { type: "string" },
        note: { type: "string" },
      },
      type: "object",
    };
    expect(
      diffContracts(contract(openBefore), contract(constrainedOptional)),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "OPTIONAL_PROPERTY_CONFLICT" }),
      ]),
    });

    const unknownBefore: JsonSchema = {
      additionalProperties: { type: "string" },
      properties: { id: { type: "string" } },
      type: "object",
    };
    const unknownNext: JsonSchema = {
      properties: {
        id: { type: "string" },
        note: { minLength: 1, type: "string" },
      },
      type: "object",
    };
    expect(
      diffContracts(contract(unknownBefore), contract(unknownNext)),
    ).toMatchObject({
      status: "unknown",
      changes: expect.arrayContaining([
        expect.objectContaining({
          code: "OPTIONAL_PROPERTY_INCLUSION_UNKNOWN",
        }),
      ]),
    });

    const enumA: JsonSchema = { enum: ["a", "b"], type: "string" };
    const enumB: JsonSchema = { enum: ["b", "a"], type: "string" };
    expect(diffContracts(contract(enumA), contract(enumB))).toMatchObject({
      changes: [],
      status: "docs-only",
    });
    expect(
      diffContracts(
        contract({ enum: [["a", "b"]] }),
        contract({ enum: [["b", "a"]] }),
      ),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "ENUM_CHANGED" }),
      ]),
    });
    expect(
      diffContracts(
        contract({ enum: [{ values: ["a", "b"] }] }),
        contract({ enum: [{ values: ["b", "a"] }] }),
      ),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "ENUM_CHANGED" }),
      ]),
    });
  });

  it("compares const/enum intersections and every additionalProperties transition", () => {
    expect(
      diffContracts(
        contract({ const: "a", enum: ["a", "b"] }),
        contract({ const: "a", enum: ["a"] }),
      ),
    ).toMatchObject({
      changes: [],
      status: "docs-only",
    });

    expect(
      diffContracts(
        contract({ const: "a", enum: ["a", "b"] }),
        contract({ const: "b", enum: ["a", "b"] }),
      ),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "FINITE_VALUE_EXCLUDED" }),
      ]),
    });

    const openObject: JsonSchema = {
      properties: { id: { type: "string" } },
      type: "object",
    };
    const constrainedObject: JsonSchema = {
      additionalProperties: { type: "string" },
      properties: { id: { type: "string" } },
      type: "object",
    };
    expect(
      diffContracts(contract(openObject), contract(constrainedObject)),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({
          code: "ADDITIONAL_PROPERTIES_RESTRICTED",
        }),
      ]),
    });
    expect(
      diffContracts(contract(constrainedObject), contract(openObject)),
    ).toMatchObject({
      status: "compatible",
      changes: expect.arrayContaining([
        expect.objectContaining({
          code: "ADDITIONAL_PROPERTIES_WIDENED",
        }),
      ]),
    });

    const finiteObject: JsonSchema = {
      const: { x: 0 },
      type: "object",
    };
    const redundantObjectConstraints: JsonSchema = {
      additionalProperties: false,
      const: { x: 0 },
      properties: { x: { const: 0 } },
      required: ["x"],
      type: "object",
    };
    expect(
      diffContracts(
        contract(finiteObject),
        contract(redundantObjectConstraints),
      ),
    ).toMatchObject({
      changes: [],
      status: "docs-only",
    });
    expect(
      diffContracts(
        contract(finiteObject),
        contract({
          ...redundantObjectConstraints,
          properties: { x: { const: 1 } },
        }),
      ),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "FINITE_VALUE_EXCLUDED" }),
      ]),
    });
  });

  it("uses Unicode code points for finite string constraints", () => {
    const emoji = { const: "😀", type: "string" } as const;
    expect(
      diffContracts(contract(emoji), contract({ ...emoji, minLength: 2 })),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "FINITE_VALUE_EXCLUDED" }),
      ]),
    });
  });

  it("does not infer types from applicators and compares undeclared required names", () => {
    const applicatorOnly: JsonSchema = {
      properties: { id: { type: "string" } },
    };
    const narrowed: JsonSchema = {
      properties: { id: { type: "string" } },
      type: ["null", "object"],
    };
    expect(
      diffContracts(contract(applicatorOnly), contract(narrowed)),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "TYPE_CONSTRAINT_ADDED" }),
      ]),
    });

    expect(
      diffContracts(
        contract({ required: ["existing"] }),
        contract({ required: ["existing", "undeclared"] }),
      ),
    ).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({
          code: "PROPERTY_BECAME_REQUIRED",
          message: expect.stringContaining("undeclared"),
        }),
      ]),
    });
  });

  it("tracks inclusive numeric bounds and never hides a narrowing", () => {
    const before: JsonSchema = {
      maximum: 10,
      minimum: 0,
      type: "number",
    };
    const after: JsonSchema = {
      exclusiveMinimum: 0,
      maximum: 20,
      type: "number",
    };
    expect(diffContracts(contract(before), contract(after))).toMatchObject({
      status: "breaking",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "MINIMUM_NARROWED" }),
        expect.objectContaining({ code: "MAXIMUM_WIDENED" }),
      ]),
    });

    expect(
      diffContracts(
        contract({ exclusiveMaximum: 1, type: "number" }),
        contract({ maximum: 1, type: "number" }),
      ),
    ).toMatchObject({
      status: "compatible",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "MAXIMUM_WIDENED" }),
      ]),
    });
  });

  it("reports dialect and otherwise unclassified semantic changes as unknown", () => {
    const previous = contract(baseSchema);
    const event = previous.eventTypes[0];
    const version = event?.versions[0];
    if (event === undefined || version === undefined) {
      throw new Error("Expected event version");
    }
    const next: CanonicalContract = {
      ...previous,
      eventTypes: [
        {
          ...event,
          versions: [
            {
              ...version,
              schema: {
                ...version.schema,
                dialect: "https://json-schema.org/draft/2020-12/schema",
              },
            },
          ],
        },
      ],
    };
    expect(diffContracts(previous, next)).toMatchObject({
      status: "unknown",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_DIALECT_CHANGED" }),
      ]),
    });

    expect(
      diffContracts(
        contract({ multipleOf: 2, type: "number" }),
        contract({ multipleOf: 3, type: "number" }),
      ),
    ).toMatchObject({
      status: "unknown",
      changes: expect.arrayContaining([
        expect.objectContaining({
          code: "UNCLASSIFIED_SCHEMA_KEYWORD_CHANGED",
        }),
      ]),
    });
  });

  it("preserves blocking severity when diff output is bounded", () => {
    const result = diffContracts(
      contract(baseSchema, { eventName: "z.removed" }),
      contract(baseSchema, { eventName: "a.added" }),
      { maxChanges: 1 },
    );
    expect(result.status).toBe("breaking");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.code).toBe("DIFF_TRUNCATED");
  });

  it("classifies unknown source extension changes as unknown", () => {
    expect(
      diffContracts(
        contract(baseSchema, { extension: "before" }),
        contract(baseSchema, { extension: "after" }),
      ),
    ).toMatchObject({
      status: "unknown",
      changes: expect.arrayContaining([
        expect.objectContaining({ code: "CONTRACT_EXTENSIONS_CHANGED" }),
      ]),
    });
  });
});

describe("fixture generation", () => {
  it("prefers explicit values and deterministically synthesizes objects", () => {
    expect(
      generateFixture({
        examples: [{ id: "explicit" }],
        type: "object",
      }),
    ).toMatchObject({
      status: "generated",
      value: { id: "explicit" },
    });

    const generated = generateFixture({
      properties: {
        count: { minimum: 2, type: "integer" },
        id: { format: "uuid", type: "string" },
        tags: { items: { type: "string" }, minItems: 2, type: "array" },
      },
      required: ["id", "count"],
      type: "object",
    });
    expect(generated).toMatchObject({
      status: "generated",
      value: {
        count: 2,
        id: "00000000-0000-4000-8000-000000000000",
        tags: ["string", "string"],
      },
    });
  });

  it("returns clear unsupported results for patterns and recursion", () => {
    expect(generateFixture({ pattern: "^x+$", type: "string" })).toMatchObject({
      status: "unsupported",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "PATTERN_FIXTURE_UNSUPPORTED" }),
      ]),
    });

    const recursive: JsonSchema = {
      properties: { child: { $ref: "#" } },
      required: ["child"],
      type: "object",
    };
    expect(generateFixture(recursive)).toMatchObject({
      status: "unsupported",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "FIXTURE_REF_CYCLE" }),
      ]),
    });
  });

  it("resolves local fixture references with sibling constraints", () => {
    expect(
      generateFixture({
        $defs: {
          Base: {
            properties: { id: { type: "string" } },
            required: ["id"],
            type: "object",
          },
        },
        $ref: "#/$defs/Base",
        properties: { kind: { const: "created" } },
        required: ["kind"],
        type: "object",
      }),
    ).toMatchObject({
      status: "generated",
      value: { id: "string", kind: "created" },
    });
  });

  it("generates negative-only numbers and respects empty arrays", () => {
    expect(generateFixture({ maximum: -1, type: "number" })).toMatchObject({
      status: "generated",
      value: -1,
    });
    expect(
      generateFixture({
        exclusiveMaximum: -1,
        maximum: -1,
        type: "integer",
      }),
    ).toMatchObject({
      status: "generated",
      value: -2,
    });
    expect(
      generateFixture({
        items: { type: "string" },
        maxItems: 0,
        type: "array",
      }),
    ).toMatchObject({
      status: "generated",
      value: [],
    });
  });

  it("bounds string allocation and aggregate fixture output", () => {
    expect(
      generateFixture(
        {
          const: "😀",
          maxLength: 1,
          minLength: 1,
          type: "string",
        },
        { maxStringLength: 1 },
      ),
    ).toMatchObject({
      diagnostics: [],
      status: "generated",
      value: "😀",
    });

    expect(
      generateFixture({ minLength: 1_000_000_000, type: "string" }),
    ).toMatchObject({
      status: "unsupported",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "FIXTURE_STRING_LIMIT_EXCEEDED" }),
      ]),
    });

    expect(
      generateFixture(
        {
          properties: {
            nested: {
              properties: {
                first: { minLength: 10, type: "string" },
                second: { minLength: 10, type: "string" },
              },
              required: ["first", "second"],
              type: "object",
            },
          },
          required: ["nested"],
          type: "object",
        },
        { maxOutputBytes: 50 },
      ),
    ).toMatchObject({
      status: "unsupported",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "FIXTURE_OUTPUT_BUDGET_EXCEEDED",
        }),
      ]),
    });

    expect(
      generateFixture(
        { default: "x".repeat(32), type: "string" },
        { maxStringLength: 16 },
      ),
    ).toMatchObject({
      status: "unsupported",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "FIXTURE_STRING_LIMIT_EXCEEDED" }),
      ]),
    });
  });

  it("isolates failed anyOf and oneOf branch budgets", () => {
    const failedObject: JsonSchema = {
      properties: {
        bad: { minLength: 100, type: "string" },
      },
      required: ["bad"],
      type: "object",
    };
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const result = generateFixture(
        {
          [keyword]: [failedObject, { type: "string" }],
        },
        { maxOutputBytes: 40 },
      );
      expect(result).toMatchObject({
        diagnostics: [],
        status: "generated",
        value: "string",
      });
    }
  });

  it("prevents nested and recursive failed branches from leaking budget", () => {
    const result = generateFixture(
      {
        $defs: {
          Recursive: {
            properties: {
              child: { $ref: "#/$defs/Recursive" },
            },
            required: ["child"],
            type: "object",
          },
        },
        anyOf: [
          {
            anyOf: [
              {
                properties: {
                  bad: { minLength: 100, type: "string" },
                },
                required: ["bad"],
                type: "object",
              },
              { $ref: "#/$defs/Recursive" },
            ],
          },
          { type: "string" },
        ],
      },
      { maxOutputBytes: 40 },
    );
    expect(result).toMatchObject({
      diagnostics: [],
      status: "generated",
      value: "string",
    });
  });

  it("checks oneOf exclusivity before committing a branch", () => {
    expect(
      generateFixture({
        oneOf: [{ type: "number" }, { const: 0 }, { const: "selected" }],
      }),
    ).toMatchObject({
      status: "generated",
      value: "selected",
    });
  });

  it("accounts for separators and final serialized UTF-8 size", () => {
    const schema: JsonSchema = {
      items: { type: "null" },
      maxItems: 100,
      minItems: 100,
      type: "array",
    };
    expect(
      generateFixture(schema, {
        maxArrayItems: 100,
        maxOutputBytes: 450,
      }),
    ).toMatchObject({
      status: "unsupported",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "FIXTURE_OUTPUT_BUDGET_EXCEEDED",
        }),
      ]),
    });

    const exact = generateFixture(schema, {
      maxArrayItems: 100,
      maxOutputBytes: 501,
    });
    expect(exact.status).toBe("generated");
    expect(Buffer.byteLength(JSON.stringify(exact.value), "utf8")).toBe(501);
  });
});

describe("TypeScript type generation", () => {
  it("generates strict object, array, and union types without any", () => {
    const result = generateTypeScript(
      {
        properties: {
          id: { type: "string" },
          values: {
            items: { anyOf: [{ type: "number" }, { type: "null" }] },
            type: "array",
          },
        },
        required: ["id"],
        type: "object",
      },
      { typeName: "event payload" },
    );

    expect(result.status).toBe("partial");
    expect(result.typeName).toBe("EventPayload");
    expect(result.code).toContain("readonly id: string");
    expect(result.code).toContain("readonly values?");
    expect(result.code).toContain("number");
    expect(result.code).toContain("null");
    expect(result.code).not.toMatch(/\bany\b/u);
  });

  it("degrades unsupported constructs explicitly to unknown", () => {
    const result = generateTypeScript(
      { not: { type: "string" }, type: "string" },
      { typeName: "Unsafe" },
    );
    expect(result).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "UNSUPPORTED_TYPE_KEYWORD" }),
      ]),
    });
    expect(result.code).toBe("export type Unsafe = unknown;\n");
    expect(result.code).not.toMatch(/\bany\b/u);
  });

  it("resolves local references and combines reference siblings", () => {
    const result = generateTypeScript({
      $defs: {
        Identifier: { type: "string" },
      },
      properties: {
        id: {
          $ref: "#/$defs/Identifier",
          enum: ["evt_1", "evt_2"],
        },
      },
      required: ["id"],
      type: "object",
    });
    expect(result.status).toBe("partial");
    expect(result.code).toContain('"evt_1" | "evt_2"');
    expect(result.code).not.toMatch(/\bany\b/u);
  });

  it("marks inexact object constraints partial and compiles witnesses", () => {
    const result = generateTypeScript(
      {
        additionalProperties: { type: "number" },
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      { typeName: "WithExtras" },
    );
    expect(result).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ADDITIONAL_PROPERTIES_TYPE_APPROXIMATED",
        }),
      ]),
    });
    expect(
      compileWitness(
        result.code,
        'const witness: WithExtras = { id: "x", extra: 1 };',
      ),
    ).toEqual([]);
  });

  it("intersects combinator siblings and models tuple tails honestly", () => {
    const combined = generateTypeScript(
      {
        enum: ["ok", 1],
        oneOf: [{ type: "string" }, { type: "number" }],
      },
      { typeName: "Combined" },
    );
    expect(combined).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ONEOF_EXCLUSIVITY_NOT_EXPRESSIBLE",
        }),
      ]),
    });
    expect(combined.code).toContain("&");
    expect(
      compileWitness(
        combined.code,
        'const text: Combined = "ok"; const number: Combined = 1;',
      ),
    ).toEqual([]);

    const tuple = generateTypeScript(
      {
        items: false,
        maxItems: 2,
        minItems: 1,
        prefixItems: [{ type: "string" }, { type: "number" }],
        type: "array",
      },
      { typeName: "TuplePayload" },
    );
    expect(tuple.status).toBe("generated");
    expect(tuple.code).toContain("number?");
    expect(
      compileWitness(
        tuple.code,
        'const short: TuplePayload = ["x"]; const full: TuplePayload = ["x", 1];',
      ),
    ).toEqual([]);
    expect(
      ajvAccepts(
        {
          items: false,
          maxItems: 2,
          minItems: 1,
          prefixItems: [{ type: "string" }, { type: "number" }],
          type: "array",
        },
        ["x", 1],
      ),
    ).toBe(true);

    const openTail = generateTypeScript(
      {
        prefixItems: [{ type: "string" }],
        type: "array",
      },
      { typeName: "OpenTail" },
    );
    expect(openTail).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "PREFIX_ITEMS_UNCONSTRAINED_TAIL",
        }),
      ]),
    });
    expect(
      compileWitness(
        openTail.code,
        'const witness: OpenTail = ["x", 1, true];',
      ),
    ).toEqual([]);
  }, 60_000);

  it("reports validation-only constraints instead of claiming exact types", () => {
    const result = generateTypeScript(
      { minLength: 3, type: "string" },
      { typeName: "LongString" },
    );
    expect(result).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "TYPE_CONSTRAINTS_OMITTED" }),
      ]),
    });
    expect(
      compileWitness(result.code, 'const witness: LongString = "long";'),
    ).toEqual([]);
  });

  it("does not infer object-only instances from properties alone", () => {
    const schema: JsonSchema = {
      properties: { id: { type: "string" } },
    };
    const result = generateTypeScript(schema, { typeName: "PropertiesOnly" });
    expect(result).toMatchObject({
      code: "export type PropertiesOnly = unknown;\n",
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_TYPE_UNSPECIFIED" }),
      ]),
    });
    expect(
      compileWitness(result.code, 'const text: PropertiesOnly = "also valid";'),
    ).toEqual([]);
    expect(ajvAccepts(schema, "also valid")).toBe(true);
  });

  it("uses object-only partial approximations for complex const values", () => {
    const emptyObject = generateTypeScript(
      { const: {} },
      { typeName: "EmptyObjectConst" },
    );
    expect(emptyObject).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CONST_COMPLEX_VALUE_APPROXIMATED",
        }),
      ]),
    });
    expect(emptyObject.code).not.toContain("= {}");
    expect(emptyObject.code).toContain("Readonly<Record<string, unknown>>");
    expect(
      compileWitness(emptyObject.code, "const valid: EmptyObjectConst = {};"),
    ).toEqual([]);
    expect(
      compileWitness(
        emptyObject.code,
        'const invalid: EmptyObjectConst = "not an object";',
      ).length,
    ).toBeGreaterThan(0);

    const arrayConst = generateTypeScript(
      { const: ["fixed", 1] },
      { typeName: "ArrayConst" },
    );
    expect(arrayConst.status).toBe("partial");
    expect(
      compileWitness(
        arrayConst.code,
        'const witness: ArrayConst = ["fixed", 1];',
      ),
    ).toEqual([]);

    const nestedObject = generateTypeScript(
      { const: { nested: {} } },
      { typeName: "NestedObjectConst" },
    );
    expect(nestedObject.status).toBe("partial");
    expect(nestedObject.code).toContain(
      "readonly nested: Readonly<Record<string, unknown>>",
    );
  });

  it("marks complex enum members as partial approximations", () => {
    const result = generateTypeScript(
      { enum: [{}, ["fixed", 1]] },
      { typeName: "ComplexEnum" },
    );
    expect(result).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ENUM_COMPLEX_VALUE_APPROXIMATED",
        }),
      ]),
    });
    expect(result.code).toContain("Readonly<Record<string, unknown>>");
    expect(
      compileWitness(
        result.code,
        'const objectValue: ComplexEnum = {}; const arrayValue: ComplexEnum = ["fixed", 1];',
      ),
    ).toEqual([]);
  });

  it("marks integer approximation partial and materializes required fields", () => {
    const integer = generateTypeScript(
      { type: "integer" },
      { typeName: "IntegerValue" },
    );
    expect(integer).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "INTEGER_TYPE_APPROXIMATED" }),
      ]),
    });
    expect(
      compileWitness(integer.code, "const fractional: IntegerValue = 1.5;"),
    ).toEqual([]);
    expect(ajvAccepts({ type: "integer" }, 1.5)).toBe(false);

    const required = generateTypeScript(
      { required: ["id"], type: "object" },
      { typeName: "RequiredUnknown" },
    );
    expect(required).toMatchObject({
      status: "partial",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "UNDECLARED_REQUIRED_PROPERTY" }),
      ]),
    });
    expect(required.code).toContain("readonly id: unknown");
    expect(
      compileWitness(
        required.code,
        "const witness: RequiredUnknown = { id: null };",
      ),
    ).toEqual([]);
    expect(ajvAccepts({ required: ["id"], type: "object" }, { id: null })).toBe(
      true,
    );
  });
});
