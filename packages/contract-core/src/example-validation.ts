// SPDX-License-Identifier: Apache-2.0

import { Ajv } from "ajv";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import {
  isJsonObject,
  type CanonicalExample,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from "@webhook-portal/canonical-model";

import {
  addAt,
  locationSource,
  type ExtractionContext,
} from "./extraction-context.js";
import { joinPointer, sortJsonValue } from "./json-utils.js";
import {
  countUniqueItemsConstraints,
  stripRegexConstraintsForValidation,
  stripUniqueItemsForValidation,
} from "./schema-processing.js";

const SECRET_KEY_PATTERN =
  /(?:^|[-_])(api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)(?:$|[-_])/iu;
const SAFE_EXAMPLE_SECRET_PATTERN =
  /(?:dummy|example|placeholder|redacted|sample|test|x{3,}|\$\{[^}]+\})/iu;

export interface ExampleComplexity {
  readonly bytes: number;
  readonly maxArrayItems: number;
  readonly maxDepth: number;
  readonly maxObjectProperties: number;
  readonly nodes: number;
  readonly secretPointer?: string;
}

export function inspectExampleComplexity(
  value: JsonValue,
  pointer: string,
): ExampleComplexity {
  const stack: {
    readonly depth: number;
    readonly pointer: string;
    readonly value: JsonValue;
  }[] = [{ depth: 0, pointer, value }];
  let bytes = 0;
  let maxArrayItems = 0;
  let maxDepth = 0;
  let maxObjectProperties = 0;
  let nodes = 0;
  let secretPointer: string | undefined;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    maxDepth = Math.max(maxDepth, current.depth);
    const candidate = current.value;
    if (candidate === null) {
      bytes += 4;
    } else if (typeof candidate === "boolean") {
      bytes += candidate ? 4 : 5;
    } else if (typeof candidate === "number") {
      bytes += Buffer.byteLength(JSON.stringify(candidate), "utf8");
    } else if (typeof candidate === "string") {
      bytes += Buffer.byteLength(JSON.stringify(candidate), "utf8");
    } else if (Array.isArray(candidate)) {
      maxArrayItems = Math.max(maxArrayItems, candidate.length);
      bytes += 2 + Math.max(0, candidate.length - 1);
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        const item = candidate[index];
        if (item !== undefined) {
          stack.push({
            depth: current.depth + 1,
            pointer: joinPointer(current.pointer, index),
            value: item,
          });
        }
      }
    } else {
      const entries = Object.entries(candidate).filter(
        (entry): entry is [string, JsonValue] => entry[1] !== undefined,
      );
      maxObjectProperties = Math.max(maxObjectProperties, entries.length);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, item] = entries[index] as [string, JsonValue];
        const childPointer = joinPointer(current.pointer, key);
        bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
        if (
          secretPointer === undefined &&
          SECRET_KEY_PATTERN.test(key) &&
          typeof item === "string" &&
          item.length >= 8 &&
          !SAFE_EXAMPLE_SECRET_PATTERN.test(item)
        ) {
          secretPointer = childPointer;
        }
        stack.push({
          depth: current.depth + 1,
          pointer: childPointer,
          value: item,
        });
      }
    }
  }

  return {
    bytes,
    maxArrayItems,
    maxDepth,
    maxObjectProperties,
    nodes,
    ...(secretPointer === undefined ? {} : { secretPointer }),
  };
}

export function makeAjv(dialect: string): Ajv | Ajv2020 {
  const options = {
    allErrors: false,
    allowUnionTypes: true,
    logger: false,
    loopEnum: 64,
    loopRequired: 64,
    strict: false,
    validateFormats: true,
  } as const;
  const ajv = dialect.includes("draft-07")
    ? new Ajv(options)
    : new Ajv2020(options);
  const addFormats = addFormatsModule.default as unknown as (
    instance: Ajv | Ajv2020,
  ) => Ajv | Ajv2020;
  addFormats(ajv);
  return ajv;
}

export function validationSchema(
  schema: JsonSchema,
  dialect: string,
  skipUniqueItems: boolean,
): JsonSchema {
  const boundedSchema = stripRegexConstraintsForValidation(
    skipUniqueItems ? stripUniqueItemsForValidation(schema) : schema,
  );
  if (!dialect.includes("spec.openapis.org/oas/3.1/dialect")) {
    return boundedSchema;
  }

  const removeDialect = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) {
      return value.map((item) => removeDialect(item));
    }
    if (!isJsonObject(value)) {
      return value;
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        item !== undefined &&
        !(
          key === "$schema" &&
          typeof item === "string" &&
          item.includes("spec.openapis.org/oas/3.1/dialect")
        )
      ) {
        result[key] = removeDialect(item);
      }
    }
    return result;
  };

  return removeDialect(boundedSchema) as JsonSchema;
}

export function compileSchema(
  schema: JsonSchema,
  dialect: string,
  skipUniqueItems: boolean,
  pointer: string,
  context: ExtractionContext,
): ValidateFunction | undefined {
  try {
    return makeAjv(dialect).compile(
      validationSchema(schema, dialect, skipUniqueItems),
    );
  } catch (error) {
    addAt(context, {
      code: "SCHEMA_COMPILE_FAILED",
      message:
        error instanceof Error
          ? `Invalid or unsupported JSON Schema: ${error.message}`
          : "Invalid or unsupported JSON Schema",
      pointer,
      severity: "error",
    });
    return undefined;
  }
}

export function ajvErrorDetails(error: ErrorObject): JsonObject {
  return {
    instancePath: error.instancePath,
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  };
}

export function validateCanonicalExamples(
  schema: JsonSchema,
  dialect: string,
  schemaPointer: string,
  schemaBytes: number,
  schemaNodes: number,
  examples: readonly CanonicalExample[],
  context: ExtractionContext,
): void {
  if (!context.validateExamples) {
    return;
  }
  const inspected = examples.map((example) => ({
    complexity: inspectExampleComplexity(
      example.value,
      example.source?.pointer ?? "",
    ),
    example,
  }));
  for (const { complexity, example } of inspected) {
    if (complexity.secretPointer !== undefined) {
      addAt(context, {
        code: "EXAMPLE_POTENTIAL_SECRET",
        message: `Example "${example.name}" contains credential-like data`,
        pointer: complexity.secretPointer,
        severity: "error",
      });
    }
  }

  const uniqueItemsConstraints = countUniqueItemsConstraints(schema);
  const largest = inspected.reduce(
    (result, { complexity }) => ({
      bytes: Math.max(result.bytes, complexity.bytes),
      items: Math.max(result.items, complexity.maxArrayItems),
    }),
    { bytes: 0, items: 0 },
  );
  const remainingOperations =
    context.references.limits.maxValidationOperations -
    context.validationBudget.used;
  const uniqueItemWork =
    uniqueItemsConstraints *
    largest.items *
    Math.max(largest.items, Math.ceil(largest.bytes / 64));
  const skipUniqueItems =
    uniqueItemsConstraints > 0 &&
    (!Number.isSafeInteger(uniqueItemWork) ||
      uniqueItemWork > Math.max(1, remainingOperations));
  if (skipUniqueItems) {
    addAt(context, {
      code: "UNIQUE_ITEMS_NOT_EVALUATED",
      details: {
        constraints: uniqueItemsConstraints,
        maximumArrayItems: largest.items,
      },
      message:
        "uniqueItems was preserved but not evaluated because its worst-case comparison cost exceeds the validation budget",
      pointer: schemaPointer,
      severity: "warning",
    });
  }

  const validate = compileSchema(
    schema,
    dialect,
    skipUniqueItems,
    schemaPointer,
    context,
  );
  if (validate === undefined || examples.length === 0) {
    return;
  }

  for (const { complexity, example } of inspected) {
    const limits = context.references.limits;
    const structuralWork =
      complexity.nodes * Math.max(1, schemaNodes) +
      Math.ceil((complexity.bytes + schemaBytes) / 64);
    const bounded =
      complexity.bytes <= limits.maxInputBytes &&
      complexity.nodes <= limits.maxNodes &&
      complexity.maxDepth <= limits.maxDepth &&
      complexity.maxObjectProperties <= limits.maxPropertiesPerObject;
    if (
      !bounded ||
      structuralWork >
        limits.maxValidationOperations - context.validationBudget.used
    ) {
      addAt(context, {
        code: "EXAMPLE_VALIDATION_BUDGET_EXCEEDED",
        details: {
          instanceBytes: complexity.bytes,
          instanceDepth: complexity.maxDepth,
          instanceNodes: complexity.nodes,
          maximumOperations: limits.maxValidationOperations,
        },
        message: `Example "${example.name}" was not synchronously validated because its bounded cost exceeds the remaining validation budget`,
        pointer: example.source?.pointer ?? schemaPointer,
        severity: "warning",
      });
      continue;
    }
    context.validationBudget.used += structuralWork;

    if (!validate(example.value)) {
      for (const error of validate.errors ?? []) {
        const pointer = `${example.source?.pointer ?? ""}${error.instancePath}`;
        addAt(context, {
          code: "EXAMPLE_SCHEMA_INVALID",
          details: ajvErrorDetails(error),
          message: `Example "${example.name}" does not satisfy its payload schema: ${error.message ?? error.keyword}`,
          pointer,
          severity: "error",
        });
      }
    }
  }
}

export function addExample(
  examples: CanonicalExample[],
  name: string,
  value: JsonValue,
  pointer: string,
  context: ExtractionContext,
  metadata?: JsonObject,
): void {
  if (examples.length >= context.references.limits.maxExamplesPerEvent) {
    addAt(context, {
      code: "EXAMPLE_LIMIT_EXCEEDED",
      message: `Event exceeds the ${context.references.limits.maxExamplesPerEvent} example limit`,
      pointer,
      severity: "error",
    });
    return;
  }

  examples.push({
    name,
    source: locationSource(context.parsed, pointer),
    value: sortJsonValue(value),
    ...(typeof metadata?.["description"] === "string"
      ? { description: metadata["description"] }
      : {}),
    ...(typeof metadata?.["summary"] === "string"
      ? { summary: metadata["summary"] }
      : {}),
  });
}
