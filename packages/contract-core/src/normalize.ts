// SPDX-License-Identifier: Apache-2.0

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { Ajv } from "ajv";
import * as addFormatsModule from "ajv-formats";

import {
  CANONICAL_EXPORT_FORMAT,
  CANONICAL_EXPORT_VERSION,
  CANONICAL_CONTRACT_JSON_SCHEMA,
  CANONICAL_MODEL_VERSION,
  CANONICAL_SCHEMA_ID,
  JSON_SCHEMA_2020_12_DIALECT,
  JSON_SCHEMA_DRAFT_07_DIALECT,
  OPENAPI_3_1_BASE_DIALECT,
  isJsonObject,
  isJsonSchema,
  isCanonicalContract,
  type CanonicalContract,
  type CanonicalContractContent,
  type CanonicalContractExport,
  type CanonicalEventType,
  type CanonicalEventVersion,
  type CanonicalExample,
  type ContractDiagnostic,
  type ContractImportStatus,
  type ContractSourceMetadata,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type Sha256Checksum,
  type SignatureHeader,
  type SignatureProfile,
  type SourcePointer,
} from "@webhook-portal/canonical-model";

import type {
  ContractImportResult,
  ContractInput,
  ContractLimits,
  ContractOptions,
  ContractValidationResult,
  ParsedContract,
} from "./api-types.js";
import { DiagnosticCollector } from "./diagnostics.js";
import {
  asBoolean,
  asObject,
  asString,
  checksumJson,
  collectExtensions,
  compareCodeUnits,
  escapePointerToken,
  joinPointer,
  jsonEqual,
  inspectJsonValue,
  sha256,
  sortJsonValue,
  stableStringify,
} from "./json-utils.js";
import { resolveLimits } from "./limits.js";
import {
  CONTRACT_CORE_NAME,
  CONTRACT_CORE_VERSION,
  isParsedContract,
  parseContract,
} from "./parser.js";
import {
  resolveObjectValue,
  type ReferenceContext,
  type ReferenceObjectKind,
} from "./refs.js";
import {
  countUniqueItemsConstraints,
  createDocumentSchemaIndex,
  processJsonSchema,
  stripRegexConstraintsForValidation,
  stripUniqueItemsForValidation,
  type SchemaLocationIndex,
} from "./schema-processing.js";
import {
  resolveAsyncApiSchemaDialect,
  validateSourceDocument,
} from "./source-validation.js";

const HTTP_METHODS = [
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "get",
  "trace",
] as const;

const INTERPRETED_CONTRACT_EXTENSIONS = [
  "x-contract-id",
  "x-signature-profile",
  "x-standard-webhooks",
] as const;
const INTERPRETED_EVENT_EXTENSIONS = [
  "x-event-type",
  "x-event-id",
  "x-event-version",
  "x-signature-profile",
  "x-standard-webhooks",
  "x-version",
] as const;

const SECRET_KEY_PATTERN =
  /(?:^|[-_])(api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)(?:$|[-_])/iu;
const SAFE_EXAMPLE_SECRET_PATTERN =
  /(?:dummy|example|placeholder|redacted|sample|test|x{3,}|\$\{[^}]+\})/iu;
let canonicalOutputValidator: ValidateFunction | undefined;

interface ExtractedEvent {
  readonly description?: string;
  readonly examples: readonly CanonicalExample[];
  readonly extensions?: JsonObject;
  readonly externalName: string;
  readonly publicVersion: string;
  readonly schema: JsonSchema;
  readonly schemaDialect: string;
  readonly schemaPointer: string;
  readonly signatureProfile?: SignatureProfile;
  readonly sourceIdentity: string;
  readonly sourcePointer: string;
  readonly title?: string;
  readonly deprecated: boolean;
}

interface ExtractionContext {
  readonly diagnostics: DiagnosticCollector;
  readonly parsed: ParsedContract;
  readonly references: ReferenceContext;
  readonly schemaIndex: SchemaLocationIndex;
  readonly schemaRootIndexes: WeakMap<JsonObject, SchemaLocationIndex>;
  readonly outputBudget: { bytes: number; exhausted: boolean; nodes: number };
  readonly validationBudget: { exhausted: boolean; used: number };
  readonly validateExamples: boolean;
}

interface ResolvedPayloadSchema {
  readonly bytes: number;
  readonly nodes: number;
  readonly schema: JsonSchema;
}

function locationSource(
  parsed: ParsedContract,
  pointer: string,
): SourcePointer {
  const location = parsed.locations[pointer];
  return location === undefined ? { pointer } : { location, pointer };
}

function addAt(
  context: ExtractionContext,
  diagnostic: {
    readonly code: string;
    readonly details?: JsonObject;
    readonly message: string;
    readonly pointer: string;
    readonly severity: "error" | "fatal" | "info" | "warning";
  },
): void {
  context.diagnostics.add({
    ...diagnostic,
    source: context.parsed.locations[diagnostic.pointer],
  });
}

function addCanonicalOutputBudgetDiagnostic(
  context: ExtractionContext,
  pointer: string,
  actualBytes: number,
  actualNodes: number,
): void {
  if (context.outputBudget.exhausted) return;
  context.outputBudget.exhausted = true;
  addAt(context, {
    code: "CANONICAL_OUTPUT_BUDGET_EXCEEDED",
    details: {
      actualBytes,
      actualNodes,
      maximumBytes: context.references.limits.maxOutputBytes,
      maximumNodes: context.references.limits.maxOutputNodes,
    },
    message: "Canonical contract exceeds the configured output budget",
    pointer,
    severity: "error",
  });
}

function reserveCanonicalOutput(
  value: JsonValue,
  pointer: string,
  context: ExtractionContext,
): boolean {
  if (context.outputBudget.exhausted) return false;
  const remainingBytes =
    context.references.limits.maxOutputBytes - context.outputBudget.bytes;
  const remainingNodes =
    context.references.limits.maxOutputNodes - context.outputBudget.nodes;
  if (remainingBytes <= 0 || remainingNodes <= 0) {
    addCanonicalOutputBudgetDiagnostic(
      context,
      pointer,
      context.outputBudget.bytes + 1,
      context.outputBudget.nodes + 1,
    );
    return false;
  }
  const inspection = inspectJsonValue(value, {
    ...context.references.limits,
    maxDepth: context.references.limits.maxDepth + 32,
    maxInputBytes: remainingBytes,
    maxNodes: remainingNodes,
  });
  if (inspection.failure !== undefined) {
    addCanonicalOutputBudgetDiagnostic(
      context,
      pointer,
      context.outputBudget.bytes + inspection.bytes,
      context.outputBudget.nodes + inspection.nodes,
    );
    return false;
  }
  context.outputBudget.bytes += inspection.bytes;
  context.outputBudget.nodes += inspection.nodes;
  return true;
}

interface NonBlankStringResult {
  readonly present: boolean;
  readonly valid: boolean;
  readonly value?: string;
}

function addExtractedEvent(
  events: ExtractedEvent[],
  event: ExtractedEvent,
  context: ExtractionContext,
): void {
  if (
    reserveCanonicalOutput(
      event as unknown as JsonValue,
      event.sourcePointer,
      context,
    )
  ) {
    events.push(event);
  }
}

function readNonBlankString(
  object: JsonObject,
  key: string,
  pointer: string,
  context: ExtractionContext,
  code = "CANONICAL_EXTENSION_VALUE_INVALID",
): NonBlankStringResult {
  if (!Object.hasOwn(object, key)) {
    return { present: false, valid: true };
  }
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim() !== value
  ) {
    addAt(context, {
      code,
      details: { field: key },
      message: `"${key}" must be a non-empty string without surrounding whitespace`,
      pointer: joinPointer(pointer, key),
      severity: "error",
    });
    return { present: true, valid: false };
  }
  return { present: true, valid: true, value };
}

function selectedString(
  primary: NonBlankStringResult,
  secondary: NonBlankStringResult,
  fallback: string,
): string | undefined {
  if (!primary.valid || !secondary.valid) return undefined;
  return primary.present
    ? primary.value
    : secondary.present
      ? secondary.value
      : fallback.trim() === "" || fallback.trim() !== fallback
        ? undefined
        : fallback;
}

function resolveObject(
  value: JsonValue | undefined,
  pointer: string,
  context: ExtractionContext,
  kind: ReferenceObjectKind,
): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    addAt(context, {
      code: "EXPECTED_OBJECT",
      message: "Expected an object",
      pointer,
      severity: "error",
    });
    return undefined;
  }
  const resolved = resolveObjectValue(value, pointer, context.references, kind);
  if (resolved === undefined) {
    return undefined;
  }
  return resolved;
}

function resolveSchema(
  value: JsonValue | undefined,
  pointer: string,
  context: ExtractionContext,
  defaultDialect: string,
): ResolvedPayloadSchema | undefined {
  if (context.validationBudget.exhausted || context.outputBudget.exhausted) {
    return undefined;
  }
  if (value === undefined) {
    addAt(context, {
      code: "PAYLOAD_SCHEMA_MISSING",
      message: "Webhook message is missing a payload JSON Schema",
      pointer,
      severity: "error",
    });
    return undefined;
  }

  if (!isJsonSchema(value)) {
    addAt(context, {
      code: "PAYLOAD_SCHEMA_INVALID",
      message: "Payload schema must be a JSON Schema object or boolean",
      pointer,
      severity: "error",
    });
    return undefined;
  }
  const processed = processJsonSchema(value, pointer, {
    defaultDialect,
    diagnostics: context.diagnostics,
    document: context.parsed.document ?? context.references.root,
    documentSchemaIndex: context.schemaIndex,
    limits: context.references.limits,
    locations: context.parsed.locations,
    referenceBudget: context.references.referenceBudget,
    rootSchemaIndexes: context.schemaRootIndexes,
    workBudget: context.validationBudget,
  });
  return processed.schema === undefined
    ? undefined
    : {
        bytes: processed.bytes,
        nodes: processed.outputNodes,
        schema: processed.schema,
      };
}

function schemaDialect(
  schema: JsonSchema,
  document: JsonObject,
  format: "asyncapi" | "openapi",
  declaredDialect?: string,
): string {
  if (isJsonObject(schema) && typeof schema["$schema"] === "string") {
    return schema["$schema"];
  }

  const documentDeclared =
    asString(document["jsonSchemaDialect"]) ??
    asString(document["defaultSchemaFormat"]);
  const normalizedDocumentDeclared =
    format === "asyncapi" && documentDeclared !== undefined
      ? resolveAsyncApiSchemaDialect(
          documentDeclared,
          document["asyncapi"] === "2.6.0" ? "2.6.0" : "3.0.0",
        )
      : documentDeclared;
  const declared = declaredDialect ?? normalizedDocumentDeclared;
  if (declared?.includes("draft-07") === true) {
    return "http://json-schema.org/draft-07/schema#";
  }
  return (
    declared ??
    (format === "openapi"
      ? OPENAPI_3_1_BASE_DIALECT
      : document["asyncapi"] === "2.6.0"
        ? JSON_SCHEMA_DRAFT_07_DIALECT
        : JSON_SCHEMA_2020_12_DIALECT)
  );
}

function signatureHeaders(
  value: JsonValue | undefined,
): SignatureHeader[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const headers: SignatureHeader[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      headers.push({ name: item, required: true });
    } else if (isJsonObject(item) && typeof item["name"] === "string") {
      headers.push({
        name: item["name"],
        required: item["required"] !== false,
      });
    }
  }

  return headers.length === 0
    ? undefined
    : headers.sort((left, right) => compareCodeUnits(left.name, right.name));
}

function signatureProfile(
  value: JsonValue | undefined,
): SignatureProfile | undefined {
  if (typeof value === "string") {
    return { name: value };
  }
  if (value === true) {
    return {
      algorithms: ["hmac-sha256"],
      headers: [
        { name: "webhook-id", required: true },
        { name: "webhook-signature", required: true },
        { name: "webhook-timestamp", required: true },
      ],
      name: "standard-webhooks",
    };
  }
  if (!isJsonObject(value)) {
    return undefined;
  }

  const name =
    asString(value["name"]) ??
    asString(value["standard"]) ??
    asString(value["type"]);
  if (name === undefined) {
    return undefined;
  }

  const algorithms = Array.isArray(value["algorithms"])
    ? value["algorithms"]
        .filter((item): item is string => typeof item === "string")
        .sort(compareCodeUnits)
    : typeof value["algorithm"] === "string"
      ? [value["algorithm"]]
      : undefined;
  const headers = signatureHeaders(value["headers"]);
  const extensions = collectExtensions(value);
  return {
    name,
    ...(algorithms === undefined || algorithms.length === 0
      ? {}
      : { algorithms }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(headers === undefined ? {} : { headers }),
    ...(typeof value["version"] === "string"
      ? { version: value["version"] }
      : {}),
  };
}

function inheritedSignature(
  local: JsonObject,
  parent: JsonObject,
  document: JsonObject,
): SignatureProfile | undefined {
  return (
    signatureProfile(local["x-signature-profile"]) ??
    signatureProfile(local["x-standard-webhooks"]) ??
    signatureProfile(parent["x-signature-profile"]) ??
    signatureProfile(parent["x-standard-webhooks"]) ??
    signatureProfile(document["x-signature-profile"]) ??
    signatureProfile(document["x-standard-webhooks"])
  );
}

interface ExampleComplexity {
  readonly bytes: number;
  readonly maxArrayItems: number;
  readonly maxDepth: number;
  readonly maxObjectProperties: number;
  readonly nodes: number;
  readonly secretPointer?: string;
}

function inspectExampleComplexity(
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

function makeAjv(dialect: string): Ajv | Ajv2020 {
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

function validationSchema(
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

function compileSchema(
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

function ajvErrorDetails(error: ErrorObject): JsonObject {
  return {
    instancePath: error.instancePath,
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  };
}

function validateCanonicalExamples(
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

function addExample(
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

function extractOpenApiExamples(
  media: JsonObject,
  schema: JsonSchema,
  mediaPointer: string,
  context: ExtractionContext,
): readonly CanonicalExample[] {
  const examples: CanonicalExample[] = [];
  if (media["example"] !== undefined) {
    addExample(
      examples,
      "default",
      media["example"],
      joinPointer(mediaPointer, "example"),
      context,
    );
  }

  const named = asObject(media["examples"]);
  if (named !== undefined) {
    for (const name of Object.keys(named).sort(compareCodeUnits)) {
      const pointer = joinPointer(joinPointer(mediaPointer, "examples"), name);
      const definition = resolveObject(
        named[name],
        pointer,
        context,
        "openapi-example",
      );
      if (definition === undefined) {
        continue;
      }
      if (typeof definition["externalValue"] === "string") {
        addAt(context, {
          code: "EXTERNAL_EXAMPLE_DENIED",
          message: "External example URLs are not fetched by contract-core",
          pointer: joinPointer(pointer, "externalValue"),
          severity: "error",
        });
      } else if (definition["value"] !== undefined) {
        addExample(
          examples,
          name,
          definition["value"],
          joinPointer(pointer, "value"),
          context,
          definition,
        );
      }
    }
  }

  if (isJsonObject(schema)) {
    if (schema["example"] !== undefined) {
      addExample(
        examples,
        "schema-example",
        schema["example"],
        joinPointer(mediaPointer, "schema/example"),
        context,
      );
    }
    if (Array.isArray(schema["examples"])) {
      schema["examples"].forEach((value, index) => {
        addExample(
          examples,
          `schema-example-${index + 1}`,
          value,
          joinPointer(mediaPointer, `schema/examples/${index}`),
          context,
        );
      });
    }
  }

  return examples.sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
}

function jsonMediaType(content: JsonObject): string | undefined {
  return Object.keys(content)
    .sort(compareCodeUnits)
    .find((type) => isJsonMediaType(type));
}

function isJsonMediaType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    (mediaType?.startsWith("application/") === true &&
      mediaType.endsWith("+json"))
  );
}

function openApiEvents(
  document: JsonObject,
  context: ExtractionContext,
): readonly ExtractedEvent[] {
  const webhooks = asObject(document["webhooks"]);
  if (webhooks === undefined || Object.keys(webhooks).length === 0) {
    addAt(context, {
      code: "OPENAPI_WEBHOOKS_MISSING",
      message:
        "OpenAPI 3.1 document must define at least one top-level webhook",
      pointer: "/webhooks",
      severity: "error",
    });
    return [];
  }

  const info = asObject(document["info"]);
  const defaultVersion = asString(info?.["version"]) ?? "1";
  const events: ExtractedEvent[] = [];

  for (const webhookName of Object.keys(webhooks).sort(compareCodeUnits)) {
    if (context.validationBudget.exhausted || context.outputBudget.exhausted) {
      break;
    }
    const webhookPointer = `/webhooks/${escapePointerToken(webhookName)}`;
    const pathItem = resolveObject(
      webhooks[webhookName],
      webhookPointer,
      context,
      "openapi-path-item",
    );
    if (pathItem === undefined) {
      continue;
    }

    const methods = HTTP_METHODS.filter((method) =>
      isJsonObject(pathItem[method]),
    );
    if (methods.length === 0) {
      addAt(context, {
        code: "OPENAPI_WEBHOOK_OPERATION_MISSING",
        message: `Webhook "${webhookName}" has no HTTP operation`,
        pointer: webhookPointer,
        severity: "error",
      });
      continue;
    }
    if (methods.length > 1) {
      addAt(context, {
        code: "OPENAPI_MULTIPLE_WEBHOOK_OPERATIONS",
        message: `Webhook "${webhookName}" defines multiple operations; each is imported explicitly`,
        pointer: webhookPointer,
        severity: "warning",
      });
    }

    for (const method of methods) {
      if (
        context.validationBudget.exhausted ||
        context.outputBudget.exhausted
      ) {
        break;
      }
      const operationPointer = joinPointer(webhookPointer, method);
      const operation = resolveObject(
        pathItem[method],
        operationPointer,
        context,
        "openapi-operation",
      );
      if (operation === undefined) {
        continue;
      }
      if (!isJsonObject(operation["responses"])) {
        addAt(context, {
          code: "OPENAPI_WEBHOOK_RESPONSES_MISSING",
          message: `Webhook operation "${webhookName}.${method}" requires a responses object`,
          pointer: joinPointer(operationPointer, "responses"),
          severity: "error",
        });
        continue;
      }

      const requestBodyPointer = joinPointer(operationPointer, "requestBody");
      const requestBody = resolveObject(
        operation["requestBody"],
        requestBodyPointer,
        context,
        "openapi-request-body",
      );
      const contentPointer = joinPointer(requestBodyPointer, "content");
      const content = asObject(requestBody?.["content"]);
      const selectedMediaType =
        content === undefined ? undefined : jsonMediaType(content);
      if (content === undefined || selectedMediaType === undefined) {
        addAt(context, {
          code: "OPENAPI_JSON_PAYLOAD_MISSING",
          message: `Webhook "${webhookName}" has no JSON request body`,
          pointer: requestBodyPointer,
          severity: "error",
        });
        continue;
      }

      const mediaPointer = joinPointer(contentPointer, selectedMediaType);
      const media = resolveObject(
        content[selectedMediaType],
        mediaPointer,
        context,
        "direct",
      );
      if (media === undefined) {
        continue;
      }
      const schemaPointer = joinPointer(mediaPointer, "schema");
      const sourceSchemaDialect = schemaDialect(
        isJsonSchema(media["schema"]) ? media["schema"] : true,
        document,
        "openapi",
      );
      const resolvedSchema = resolveSchema(
        media["schema"],
        schemaPointer,
        context,
        sourceSchemaDialect,
      );
      if (resolvedSchema === undefined) {
        continue;
      }
      const schema = resolvedSchema.schema;

      const externalName = selectedString(
        readNonBlankString(
          operation,
          "x-event-type",
          operationPointer,
          context,
        ),
        readNonBlankString(pathItem, "x-event-type", webhookPointer, context),
        `${webhookName}.${method}`,
      );
      const publicVersion = selectedString(
        readNonBlankString(
          operation,
          "x-event-version",
          operationPointer,
          context,
        ),
        readNonBlankString(
          pathItem,
          "x-event-version",
          webhookPointer,
          context,
        ),
        defaultVersion,
      );
      const selectedIdentity = selectedString(
        readNonBlankString(operation, "x-event-id", operationPointer, context),
        readNonBlankString(pathItem, "x-event-id", webhookPointer, context),
        `openapi:${webhookPointer}:${method}`,
      );
      if (
        externalName === undefined ||
        publicVersion === undefined ||
        selectedIdentity === undefined
      ) {
        addAt(context, {
          code: "CANONICAL_EVENT_IDENTITY_INVALID",
          message:
            "Event name, public version, and source identity must be non-empty",
          pointer: operationPointer,
          severity: "error",
        });
        continue;
      }
      const examples = extractOpenApiExamples(
        media,
        schema,
        mediaPointer,
        context,
      );
      const dialect = schemaDialect(schema, document, "openapi");
      validateCanonicalExamples(
        schema,
        dialect,
        schemaPointer,
        resolvedSchema.bytes,
        resolvedSchema.nodes,
        examples,
        context,
      );

      const description = asString(operation["description"]);
      const extensions = collectExtensions(
        operation,
        INTERPRETED_EVENT_EXTENSIONS,
      );
      const operationSignature = inheritedSignature(
        operation,
        pathItem,
        document,
      );
      const title = asString(operation["summary"]);
      addExtractedEvent(
        events,
        {
          deprecated: asBoolean(operation["deprecated"]) ?? false,
          examples,
          externalName,
          publicVersion,
          schema,
          schemaDialect: dialect,
          schemaPointer,
          sourceIdentity: selectedIdentity,
          sourcePointer: operationPointer,
          ...(description === undefined ? {} : { description }),
          ...(extensions === undefined ? {} : { extensions }),
          ...(operationSignature === undefined
            ? {}
            : { signatureProfile: operationSignature }),
          ...(title === undefined ? {} : { title }),
        },
        context,
      );
    }
  }

  return events;
}

function asyncApiExamples(
  message: JsonObject,
  messagePointer: string,
  context: ExtractionContext,
): readonly CanonicalExample[] {
  const examples: CanonicalExample[] = [];
  const source = message["examples"];
  if (Array.isArray(source)) {
    source.forEach((item, index) => {
      const pointer = joinPointer(
        joinPointer(messagePointer, "examples"),
        index,
      );
      if (isJsonObject(item) && item["payload"] !== undefined) {
        addExample(
          examples,
          asString(item["name"]) ?? `example-${index + 1}`,
          item["payload"],
          joinPointer(pointer, "payload"),
          context,
          item,
        );
      } else {
        addExample(examples, `example-${index + 1}`, item, pointer, context);
      }
    });
  }
  if (message["example"] !== undefined) {
    addExample(
      examples,
      "default",
      message["example"],
      joinPointer(messagePointer, "example"),
      context,
    );
  }
  return examples.sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
}

function addAsyncMessage(
  messageValue: JsonValue,
  messagePointer: string,
  fallbackName: string,
  sourceIdentity: string,
  defaultVersion: string,
  document: JsonObject,
  events: ExtractedEvent[],
  context: ExtractionContext,
): void {
  if (context.outputBudget.exhausted) return;
  const message = resolveObject(
    messageValue,
    messagePointer,
    context,
    "asyncapi-message",
  );
  if (message === undefined) {
    return;
  }

  const asyncApiVersion = document["asyncapi"] === "2.6.0" ? "2.6.0" : "3.0.0";
  const declaredSchemaDialect = resolveAsyncApiSchemaDialect(
    message["schemaFormat"] ?? document["defaultSchemaFormat"],
    asyncApiVersion,
  );
  if (declaredSchemaDialect === undefined) {
    addAt(context, {
      code: "ASYNCAPI_SCHEMA_FORMAT_UNSUPPORTED",
      message: `AsyncAPI message uses unsupported schema format "${String(message["schemaFormat"])}"`,
      pointer: joinPointer(messagePointer, "schemaFormat"),
      severity: "error",
    });
    return;
  }
  const contentType =
    asString(message["contentType"]) ??
    asString(document["defaultContentType"]);
  if (contentType !== undefined && !isJsonMediaType(contentType)) {
    addAt(context, {
      code: "ASYNCAPI_MEDIA_TYPE_UNSUPPORTED",
      message: `AsyncAPI message media type "${contentType}" is not JSON`,
      pointer:
        asString(message["contentType"]) === undefined
          ? "/defaultContentType"
          : joinPointer(messagePointer, "contentType"),
      severity: "error",
    });
    return;
  }

  if (Array.isArray(message["oneOf"])) {
    message["oneOf"].forEach((item, index) => {
      addAsyncMessage(
        item,
        joinPointer(joinPointer(messagePointer, "oneOf"), index),
        `${fallbackName}.${index + 1}`,
        `${sourceIdentity}:oneOf:${index}`,
        defaultVersion,
        document,
        events,
        context,
      );
    });
    return;
  }

  const schemaPointer = joinPointer(messagePointer, "payload");
  const sourceSchemaDialect = schemaDialect(
    isJsonSchema(message["payload"]) ? message["payload"] : true,
    document,
    "asyncapi",
    declaredSchemaDialect,
  );
  const resolvedSchema = resolveSchema(
    message["payload"],
    schemaPointer,
    context,
    sourceSchemaDialect,
  );
  if (resolvedSchema === undefined) {
    return;
  }
  const schema = resolvedSchema.schema;
  const examples = asyncApiExamples(message, messagePointer, context);
  const dialect = schemaDialect(
    schema,
    document,
    "asyncapi",
    declaredSchemaDialect,
  );
  validateCanonicalExamples(
    schema,
    dialect,
    schemaPointer,
    resolvedSchema.bytes,
    resolvedSchema.nodes,
    examples,
    context,
  );

  const description = asString(message["description"]);
  const extensions = collectExtensions(message, INTERPRETED_EVENT_EXTENSIONS);
  const messageSignature = inheritedSignature(message, message, document);
  const title = asString(message["title"]);
  const extensionName = readNonBlankString(
    message,
    "x-event-type",
    messagePointer,
    context,
  );
  const messageName = readNonBlankString(
    message,
    "name",
    messagePointer,
    context,
    "CANONICAL_SOURCE_NAME_INVALID",
  );
  const messageId = readNonBlankString(
    message,
    "messageId",
    messagePointer,
    context,
    "CANONICAL_SOURCE_NAME_INVALID",
  );
  const eventVersion = readNonBlankString(
    message,
    "x-event-version",
    messagePointer,
    context,
  );
  const alternateVersion = readNonBlankString(
    message,
    "x-version",
    messagePointer,
    context,
  );
  const eventIdentity = readNonBlankString(
    message,
    "x-event-id",
    messagePointer,
    context,
  );
  if (
    !extensionName.valid ||
    !messageName.valid ||
    !messageId.valid ||
    !eventVersion.valid ||
    !alternateVersion.valid ||
    !eventIdentity.valid
  ) {
    return;
  }
  const externalName = extensionName.present
    ? extensionName.value
    : messageName.present
      ? messageName.value
      : messageId.present
        ? messageId.value
        : fallbackName.trim() === "" || fallbackName.trim() !== fallbackName
          ? undefined
          : fallbackName;
  const publicVersion = eventVersion.present
    ? eventVersion.value
    : alternateVersion.present
      ? alternateVersion.value
      : defaultVersion.trim() === "" || defaultVersion.trim() !== defaultVersion
        ? undefined
        : defaultVersion;
  const canonicalIdentity = eventIdentity.present
    ? eventIdentity.value
    : sourceIdentity.trim() === "" || sourceIdentity.trim() !== sourceIdentity
      ? undefined
      : sourceIdentity;
  if (
    externalName === undefined ||
    publicVersion === undefined ||
    canonicalIdentity === undefined
  ) {
    addAt(context, {
      code: "CANONICAL_EVENT_IDENTITY_INVALID",
      message:
        "Event name, public version, and source identity must be non-empty",
      pointer: messagePointer,
      severity: "error",
    });
    return;
  }
  addExtractedEvent(
    events,
    {
      deprecated: asBoolean(message["deprecated"]) ?? false,
      examples,
      externalName,
      publicVersion,
      schema,
      schemaDialect: dialect,
      schemaPointer,
      sourceIdentity: canonicalIdentity,
      sourcePointer: messagePointer,
      ...(description === undefined ? {} : { description }),
      ...(extensions === undefined ? {} : { extensions }),
      ...(messageSignature === undefined
        ? {}
        : { signatureProfile: messageSignature }),
      ...(title === undefined ? {} : { title }),
    },
    context,
  );
}

function asyncApiEvents(
  document: JsonObject,
  version: string,
  context: ExtractionContext,
): readonly ExtractedEvent[] {
  const channels = asObject(document["channels"]);
  if (channels === undefined || Object.keys(channels).length === 0) {
    addAt(context, {
      code: "ASYNCAPI_CHANNELS_MISSING",
      message: "AsyncAPI document must define at least one channel",
      pointer: "/channels",
      severity: "error",
    });
    return [];
  }

  const info = asObject(document["info"]);
  const defaultVersion = asString(info?.["version"]) ?? "1";
  const events: ExtractedEvent[] = [];

  if (version.startsWith("2.6.")) {
    for (const channelName of Object.keys(channels).sort(compareCodeUnits)) {
      if (
        context.validationBudget.exhausted ||
        context.outputBudget.exhausted
      ) {
        break;
      }
      const channelPointer = `/channels/${escapePointerToken(channelName)}`;
      const channel = resolveObject(
        channels[channelName],
        channelPointer,
        context,
        "asyncapi-channel",
      );
      const operationPointer = joinPointer(channelPointer, "subscribe");
      const operation = resolveObject(
        channel?.["subscribe"],
        operationPointer,
        context,
        "asyncapi-operation",
      );
      if (operation?.["message"] === undefined) {
        continue;
      }
      addAsyncMessage(
        operation["message"],
        joinPointer(operationPointer, "message"),
        channelName,
        `asyncapi2:${channelPointer}:subscribe`,
        defaultVersion,
        document,
        events,
        context,
      );
    }
  } else {
    const operations = asObject(document["operations"]);
    if (operations !== undefined) {
      for (const operationName of Object.keys(operations).sort(
        compareCodeUnits,
      )) {
        if (
          context.validationBudget.exhausted ||
          context.outputBudget.exhausted
        ) {
          break;
        }
        const operationPointer = `/operations/${escapePointerToken(operationName)}`;
        const operation = resolveObject(
          operations[operationName],
          operationPointer,
          context,
          "asyncapi-operation",
        );
        if (operation?.["action"] !== "send") {
          continue;
        }
        const channelPointer = joinPointer(operationPointer, "channel");
        const channel =
          operation["channel"] === undefined
            ? undefined
            : resolveObject(
                operation["channel"],
                channelPointer,
                context,
                "asyncapi-channel",
              );
        if (channel === undefined) {
          addAt(context, {
            code: "ASYNCAPI_SEND_CHANNEL_MISSING",
            message: `Send operation "${operationName}" must reference a channel`,
            pointer: channelPointer,
            severity: "error",
          });
          continue;
        }
        const channelMessages = asObject(channel["messages"]);
        if (
          channelMessages === undefined ||
          Object.keys(channelMessages).length === 0
        ) {
          addAt(context, {
            code: "ASYNCAPI_CHANNEL_MESSAGES_MISSING",
            message: `Send operation "${operationName}" references a channel without messages`,
            pointer: joinPointer(channelPointer, "messages"),
            severity: "error",
          });
          continue;
        }

        const availableMessages = Object.keys(channelMessages)
          .sort(compareCodeUnits)
          .flatMap((name) => {
            const pointer = joinPointer(
              joinPointer(channelPointer, "messages"),
              name,
            );
            const raw = channelMessages[name];
            const resolved =
              raw === undefined
                ? undefined
                : resolveObject(raw, pointer, context, "asyncapi-message");
            return raw === undefined || resolved === undefined
              ? []
              : [{ name, pointer, raw, resolved }];
          });
        const requested = operation["messages"];
        const selected:
          | readonly {
              readonly identity: string;
              readonly pointer: string;
              readonly raw: JsonValue;
            }[]
          | undefined =
          requested === undefined
            ? availableMessages.map(({ name, pointer, raw }) => ({
                identity: `asyncapi3:${channelPointer}:message:${name}`,
                pointer,
                raw,
              }))
            : Array.isArray(requested)
              ? requested.flatMap((message, index) => {
                  const pointer = joinPointer(
                    joinPointer(operationPointer, "messages"),
                    index,
                  );
                  const resolved = resolveObject(
                    message,
                    pointer,
                    context,
                    "asyncapi-message",
                  );
                  const match =
                    resolved === undefined
                      ? undefined
                      : availableMessages.find(({ resolved: candidate }) =>
                          jsonEqual(candidate, resolved),
                        );
                  if (match === undefined) {
                    addAt(context, {
                      code: "ASYNCAPI_SEND_MESSAGE_NOT_IN_CHANNEL",
                      message: `Send operation "${operationName}" references a message outside its channel`,
                      pointer,
                      severity: "error",
                    });
                    return [];
                  }
                  return [
                    {
                      identity:
                        isJsonObject(message) &&
                        typeof message["$ref"] === "string"
                          ? `asyncapi3:${message["$ref"]}`
                          : `asyncapi3:${channelPointer}:message:${match.name}`,
                      pointer,
                      raw: message,
                    },
                  ];
                })
              : undefined;
        if (selected === undefined || selected.length === 0) {
          addAt(context, {
            code: "ASYNCAPI_SEND_MESSAGES_MISSING",
            message: `Send operation "${operationName}" has no usable channel messages`,
            pointer: joinPointer(operationPointer, "messages"),
            severity: "error",
          });
          continue;
        }
        selected.forEach(({ identity, pointer, raw }) => {
          addAsyncMessage(
            raw,
            pointer,
            operationName,
            identity,
            defaultVersion,
            document,
            events,
            context,
          );
        });
      }
    }
  }

  if (events.length === 0) {
    addAt(context, {
      code: "ASYNCAPI_OUTBOUND_MESSAGES_MISSING",
      message: "No outbound producer messages were found",
      pointer: version.startsWith("2.6.") ? "/channels" : "/operations",
      severity: "error",
    });
  }
  return events;
}

function validateDeclaredSchemas(
  document: JsonObject,
  format: "asyncapi" | "openapi",
  context: ExtractionContext,
): void {
  const components = asObject(document["components"]);
  const schemas = asObject(components?.["schemas"]);
  if (schemas !== undefined) {
    for (const name of Object.keys(schemas).sort(compareCodeUnits)) {
      if (context.validationBudget.exhausted) break;
      const pointer = `/components/schemas/${escapePointerToken(name)}`;
      const sourceDialect = schemaDialect(
        isJsonSchema(schemas[name]) ? schemas[name] : true,
        document,
        format,
      );
      const resolved = resolveSchema(
        schemas[name],
        pointer,
        context,
        sourceDialect,
      );
      if (resolved !== undefined) {
        validateCanonicalExamples(
          resolved.schema,
          schemaDialect(resolved.schema, document, format),
          pointer,
          resolved.bytes,
          resolved.nodes,
          [],
          context,
        );
      }
    }
  }

  if (format === "asyncapi") {
    const messages = asObject(components?.["messages"]);
    if (messages !== undefined) {
      for (const name of Object.keys(messages).sort(compareCodeUnits)) {
        if (context.validationBudget.exhausted) break;
        const pointer = `/components/messages/${escapePointerToken(name)}`;
        const message = resolveObject(
          messages[name],
          pointer,
          context,
          "asyncapi-message",
        );
        if (message?.["payload"] === undefined) {
          continue;
        }
        const asyncApiVersion =
          document["asyncapi"] === "2.6.0" ? "2.6.0" : "3.0.0";
        const declaredSchemaDialect = resolveAsyncApiSchemaDialect(
          message["schemaFormat"] ?? document["defaultSchemaFormat"],
          asyncApiVersion,
        );
        if (declaredSchemaDialect === undefined) {
          addAt(context, {
            code: "ASYNCAPI_SCHEMA_FORMAT_UNSUPPORTED",
            message: `AsyncAPI message uses unsupported schema format "${String(message["schemaFormat"])}"`,
            pointer: joinPointer(pointer, "schemaFormat"),
            severity: "error",
          });
          continue;
        }
        const schemaPointer = joinPointer(pointer, "payload");
        const resolved = resolveSchema(
          message["payload"],
          schemaPointer,
          context,
          schemaDialect(
            isJsonSchema(message["payload"]) ? message["payload"] : true,
            document,
            format,
            declaredSchemaDialect,
          ),
        );
        if (resolved !== undefined) {
          validateCanonicalExamples(
            resolved.schema,
            schemaDialect(
              resolved.schema,
              document,
              format,
              declaredSchemaDialect,
            ),
            schemaPointer,
            resolved.bytes,
            resolved.nodes,
            [],
            context,
          );
        }
      }
    }
  }
}

function eventId(sourceIdentity: string): string {
  return `evt_${sha256(sourceIdentity).value.slice(0, 20)}`;
}

function eventVersionId(id: string, publicVersion: string): string {
  return `evv_${sha256(`${id}\u0000${publicVersion}`).value.slice(0, 20)}`;
}

function eventVersionSemantics(version: CanonicalEventVersion): JsonObject {
  return {
    ...(version.deprecation === undefined
      ? {}
      : { deprecation: version.deprecation as unknown as JsonValue }),
    ...(version.description === undefined
      ? {}
      : { description: version.description }),
    examples: version.examples.map((example) => ({
      ...(example.description === undefined
        ? {}
        : { description: example.description }),
      name: example.name,
      ...(example.summary === undefined ? {} : { summary: example.summary }),
      value: example.value,
    })),
    ...(version.extensions === undefined
      ? {}
      : { extensions: version.extensions }),
    publicVersion: version.publicVersion,
    schema: {
      dialect: version.schema.dialect,
      value: version.schema.value,
    },
    ...(version.signatureProfile === undefined
      ? {}
      : {
          signatureProfile: version.signatureProfile as unknown as JsonValue,
        }),
    ...(version.title === undefined ? {} : { title: version.title }),
  };
}

function semanticDifferenceFields(
  previous: JsonObject,
  next: JsonObject,
): readonly string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .sort(compareCodeUnits)
    .filter((key) => !jsonEqual(previous[key] ?? null, next[key] ?? null));
}

function mergeEvents(
  extracted: readonly ExtractedEvent[],
  context: ExtractionContext,
): readonly CanonicalEventType[] {
  const eventTypes = new Map<string, CanonicalEventType>();

  for (const event of [...extracted].sort((left, right) => {
    const name = compareCodeUnits(left.externalName, right.externalName);
    if (name !== 0) return name;
    const version = compareCodeUnits(left.publicVersion, right.publicVersion);
    if (version !== 0) return version;
    const identity = compareCodeUnits(
      left.sourceIdentity,
      right.sourceIdentity,
    );
    return identity !== 0
      ? identity
      : compareCodeUnits(left.sourcePointer, right.sourcePointer);
  })) {
    const existing = eventTypes.get(event.externalName);
    const id = eventId(event.sourceIdentity);
    const version: CanonicalEventVersion = {
      examples: event.examples,
      id: eventVersionId(id, event.publicVersion),
      publicVersion: event.publicVersion,
      schema: {
        checksum: checksumJson(event.schema),
        dialect: event.schemaDialect,
        source: locationSource(context.parsed, event.schemaPointer),
        value: sortJsonValue(event.schema) as JsonSchema,
      },
      source: locationSource(context.parsed, event.sourcePointer),
      ...(event.deprecated
        ? { deprecation: { deprecated: true } as const }
        : {}),
      ...(event.description === undefined
        ? {}
        : { description: event.description }),
      ...(event.extensions === undefined
        ? {}
        : { extensions: event.extensions }),
      ...(event.signatureProfile === undefined
        ? {}
        : { signatureProfile: event.signatureProfile }),
      ...(event.title === undefined ? {} : { title: event.title }),
    };

    if (existing === undefined) {
      if (eventTypes.size >= context.references.limits.maxEvents) {
        addAt(context, {
          code: "EVENT_LIMIT_EXCEEDED",
          message: `Contract exceeds the ${context.references.limits.maxEvents} event limit`,
          pointer: event.sourcePointer,
          severity: "fatal",
        });
        break;
      }
      eventTypes.set(event.externalName, {
        externalName: event.externalName,
        id,
        versions: [version],
        ...(event.description === undefined
          ? {}
          : { description: event.description }),
        ...(event.extensions === undefined
          ? {}
          : { extensions: event.extensions }),
        ...(event.title === undefined ? {} : { title: event.title }),
      });
      continue;
    }

    if (existing.id !== id) {
      addAt(context, {
        code: "EVENT_IDENTITY_CONFLICT",
        details: { event: event.externalName },
        message: `Event "${event.externalName}" maps to multiple immutable source identities; add an explicit x-event-id or unique x-event-type`,
        pointer: event.sourcePointer,
        severity: "error",
      });
      continue;
    }

    const duplicate = existing.versions.find(
      ({ publicVersion }) => publicVersion === event.publicVersion,
    );
    if (duplicate !== undefined) {
      const previousSemantics = eventVersionSemantics(duplicate);
      const nextSemantics = eventVersionSemantics(version);
      if (!jsonEqual(previousSemantics, nextSemantics)) {
        const differences = semanticDifferenceFields(
          previousSemantics,
          nextSemantics,
        );
        addAt(context, {
          code: "DUPLICATE_EVENT_VERSION_CONFLICT",
          details: {
            differences,
            event: event.externalName,
            version: event.publicVersion,
          },
          message: `Event "${event.externalName}" version "${event.publicVersion}" has conflicting semantic definitions (${differences.join(", ")})`,
          pointer: event.sourcePointer,
          severity: "error",
        });
      }
      continue;
    }

    eventTypes.set(event.externalName, {
      ...existing,
      versions: [...existing.versions, version].sort((left, right) =>
        compareCodeUnits(left.publicVersion, right.publicVersion),
      ),
    });
  }

  return [...eventTypes.values()].sort((left, right) =>
    compareCodeUnits(left.externalName, right.externalName),
  );
}

function statusFor(
  diagnostics: readonly ContractDiagnostic[],
  supported: boolean,
): ContractImportStatus {
  if (diagnostics.some(({ severity }) => severity === "fatal")) {
    return "invalid";
  }
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  if (errors.some(({ code }) => code !== "UNSUPPORTED_SOURCE_VERSION")) {
    return "invalid";
  }
  if (!supported || errors.length > 0) {
    return "partial";
  }
  if (
    diagnostics.some(
      ({ code }) =>
        code === "REGEX_CONSTRAINTS_NOT_EVALUATED" ||
        code === "UNIQUE_ITEMS_NOT_EVALUATED" ||
        code === "EXAMPLE_VALIDATION_BUDGET_EXCEEDED",
    )
  ) {
    return "partial";
  }
  return "valid";
}

function semanticChecksumValue(
  contract: CanonicalContract | CanonicalContractContent,
): JsonValue {
  const eventTypes = contract.eventTypes.map((event) => ({
    ...event,
    versions: event.versions.map((version) => ({
      ...version,
      examples: version.examples.map((example) => ({
        ...example,
        ...(example.source === undefined
          ? {}
          : { source: { pointer: example.source.pointer } }),
      })),
      schema: {
        ...version.schema,
        ...(version.schema.source === undefined
          ? {}
          : { source: { pointer: version.schema.source.pointer } }),
      },
      source: { pointer: version.source.pointer },
    })),
  }));
  return {
    $schema: contract.$schema,
    eventTypes: eventTypes as unknown as JsonValue,
    ...(contract.extensions === undefined
      ? {}
      : { extensions: contract.extensions }),
    id: contract.id,
    modelVersion: contract.modelVersion,
    ...(contract.signatureProfile === undefined
      ? {}
      : {
          signatureProfile: contract.signatureProfile as unknown as JsonValue,
        }),
    source: {
      ...(contract.source.extensions === undefined
        ? {}
        : { extensions: contract.source.extensions }),
      format: contract.source.format,
      specificationVersion: contract.source.specificationVersion,
    },
    ...(contract.title === undefined ? {} : { title: contract.title }),
    ...(contract.version === undefined ? {} : { version: contract.version }),
  };
}

/**
 * Computes the release checksum from canonical semantics. Raw source bytes,
 * source URI, media type, and parser metadata are intentionally excluded.
 */
export function computeCanonicalChecksum(
  contract: CanonicalContract | CanonicalContractContent,
): Sha256Checksum {
  return checksumJson(semanticChecksumValue(contract));
}

function contractId(
  document: JsonObject,
  format: "asyncapi" | "openapi",
  title: string | undefined,
): string {
  const explicit =
    typeof document["x-contract-id"] === "string" &&
    document["x-contract-id"].trim() !== ""
      ? document["x-contract-id"]
      : undefined;
  return (
    explicit ??
    `contract_${sha256(`${format}\u0000${title ?? "default"}`).value.slice(0, 20)}`
  );
}

function validateTopLevelCanonicalFields(
  parsed: ParsedContract,
  diagnostics: DiagnosticCollector,
): void {
  const document = parsed.document;
  if (document === undefined) return;
  if (Object.hasOwn(document, "x-contract-id")) {
    const value = document["x-contract-id"];
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value.trim() !== value
    ) {
      diagnostics.add({
        code: "CANONICAL_EXTENSION_VALUE_INVALID",
        details: { field: "x-contract-id" },
        message:
          '"x-contract-id" must be a non-empty string without surrounding whitespace',
        pointer: "/x-contract-id",
        severity: "error",
        source: parsed.locations["/x-contract-id"],
      });
    }
  }
}

function canonicalOutputWithinLimits(
  value: JsonValue,
  limits: ContractLimits,
  diagnostics: DiagnosticCollector,
): boolean {
  const inspection = inspectJsonValue(value, {
    ...limits,
    maxDepth: limits.maxDepth + 32,
    maxInputBytes: limits.maxOutputBytes,
    maxNodes: limits.maxOutputNodes,
  });
  if (inspection.failure === undefined) return true;
  diagnostics.add({
    code: "CANONICAL_OUTPUT_BUDGET_EXCEEDED",
    details: {
      actualBytes: inspection.bytes,
      actualNodes: inspection.nodes,
      maximumBytes: limits.maxOutputBytes,
      maximumNodes: limits.maxOutputNodes,
    },
    message: "Canonical contract exceeds the configured output budget",
    pointer: inspection.failure.pointer,
    severity: "error",
  });
  return false;
}

function canonicalContract(
  parsed: ParsedContract,
  events: readonly CanonicalEventType[],
  limits: ContractLimits,
  diagnostics: DiagnosticCollector,
): CanonicalContract | undefined {
  if (
    parsed.document === undefined ||
    parsed.format === undefined ||
    parsed.mediaType === undefined ||
    parsed.sourceChecksum === undefined ||
    parsed.specificationVersion === undefined
  ) {
    return undefined;
  }

  const info = asObject(parsed.document["info"]);
  const title = asString(info?.["title"]);
  const version = asString(info?.["version"]);
  const extensions = collectExtensions(
    parsed.document,
    INTERPRETED_CONTRACT_EXTENSIONS,
  );
  const topLevelSignature =
    signatureProfile(parsed.document["x-signature-profile"]) ??
    signatureProfile(parsed.document["x-standard-webhooks"]);
  const source: ContractSourceMetadata = {
    format: parsed.format,
    mediaType: parsed.mediaType,
    parser: { name: CONTRACT_CORE_NAME, version: CONTRACT_CORE_VERSION },
    sourceChecksum: parsed.sourceChecksum,
    specificationVersion: parsed.specificationVersion,
    ...(extensions === undefined ? {} : { extensions }),
    ...(parsed.sourceUri === undefined ? {} : { sourceUri: parsed.sourceUri }),
  };
  const content: CanonicalContractContent = {
    $schema: CANONICAL_SCHEMA_ID,
    eventTypes: events,
    id: contractId(parsed.document, parsed.format, title),
    modelVersion: CANONICAL_MODEL_VERSION,
    source,
    ...(extensions === undefined ? {} : { extensions }),
    ...(topLevelSignature === undefined
      ? {}
      : { signatureProfile: topLevelSignature }),
    ...(title === undefined ? {} : { title }),
    ...(version === undefined ? {} : { version }),
  };
  if (
    !canonicalOutputWithinLimits(
      content as unknown as JsonValue,
      limits,
      diagnostics,
    )
  ) {
    return undefined;
  }
  const contract: CanonicalContract = {
    ...content,
    checksum: computeCanonicalChecksum(content),
  };
  if (
    !canonicalOutputWithinLimits(
      contract as unknown as JsonValue,
      limits,
      diagnostics,
    )
  ) {
    return undefined;
  }
  return sortJsonValue(
    contract as unknown as JsonValue,
  ) as unknown as CanonicalContract;
}

function validateCanonicalOutput(
  contract: CanonicalContract,
  diagnostics: DiagnosticCollector,
): boolean {
  let valid = isCanonicalContract(contract);
  if (!valid) {
    diagnostics.add({
      code: "CANONICAL_CONTRACT_GUARD_FAILED",
      message: "Generated canonical contract failed its runtime guard",
      severity: "error",
    });
  }
  canonicalOutputValidator ??= new Ajv2020({
    allErrors: true,
    logger: false,
    strict: false,
    validateFormats: false,
  }).compile(CANONICAL_CONTRACT_JSON_SCHEMA);
  if (!canonicalOutputValidator(contract)) {
    valid = false;
    for (const error of canonicalOutputValidator.errors ?? []) {
      const pointer =
        error.keyword === "required" &&
        typeof error.params["missingProperty"] === "string"
          ? joinPointer(error.instancePath, error.params["missingProperty"])
          : error.instancePath;
      diagnostics.add({
        code: "CANONICAL_CONTRACT_SCHEMA_INVALID",
        details: {
          keyword: error.keyword,
          schemaPath: error.schemaPath,
        },
        message: `Generated canonical contract is invalid: ${error.message ?? error.keyword}`,
        pointer,
        severity: "error",
      });
    }
  }
  return valid;
}

function canonicalExport(
  parsed: ParsedContract,
  contract: CanonicalContract,
): CanonicalContractExport {
  const original =
    typeof parsed.original === "string"
      ? {
          kind: "text" as const,
          mediaType: parsed.mediaType ?? "application/json",
          value: parsed.original,
        }
      : {
          kind: "document" as const,
          mediaType: parsed.mediaType ?? "application/json",
          value: sortJsonValue(parsed.original) as JsonObject,
        };

  return {
    canonical: contract,
    checksums: {
      canonical: contract.checksum,
      source: parsed.sourceChecksum ?? sha256(stableStringify(parsed.original)),
    },
    format: CANONICAL_EXPORT_FORMAT,
    formatVersion: CANONICAL_EXPORT_VERSION,
    original,
  };
}

function processContract(
  input: ContractInput | ParsedContract,
  options: ContractOptions,
  includeCanonical: boolean,
): ContractImportResult {
  const limits = resolveLimits(options.limits);
  const parsed = isParsedContract(input)
    ? input
    : parseContract(input, options);
  const diagnostics = new DiagnosticCollector(limits.maxDiagnostics);
  diagnostics.addAll(parsed.diagnostics);

  let events: readonly CanonicalEventType[] = [];
  if (
    parsed.document !== undefined &&
    parsed.format !== undefined &&
    parsed.specificationVersion !== undefined
  ) {
    if (parsed.supported) {
      validateSourceDocument(
        parsed.document,
        parsed.format,
        parsed.specificationVersion,
        parsed.locations,
        diagnostics,
      );
      validateTopLevelCanonicalFields(parsed, diagnostics);
    }

    const references: ReferenceContext = {
      diagnostics,
      documentId: "local",
      limits,
      locations: parsed.locations,
      referenceBudget: { count: 0, exceeded: false, seen: new Set() },
      root: parsed.document,
      sourceFormat: parsed.format,
      specificationVersion: parsed.specificationVersion,
    };
    if (parsed.supported && !diagnostics.hasErrors()) {
      const validationBudget = { exhausted: false, used: 0 };
      const schemaIndex = createDocumentSchemaIndex(parsed.document, {
        diagnostics,
        limits,
        locations: parsed.locations,
        workBudget: validationBudget,
      });
      const extraction: ExtractionContext = {
        diagnostics,
        outputBudget: { bytes: 0, exhausted: false, nodes: 0 },
        parsed,
        references,
        schemaIndex,
        schemaRootIndexes: new WeakMap(),
        validationBudget,
        validateExamples: true,
      };
      validateDeclaredSchemas(parsed.document, parsed.format, extraction);
      const extracted = diagnostics.hasErrors()
        ? []
        : parsed.format === "openapi"
          ? openApiEvents(parsed.document, extraction)
          : asyncApiEvents(
              parsed.document,
              parsed.specificationVersion,
              extraction,
            );
      events = mergeEvents(extracted, extraction);
    }
  }

  let canonicalCandidate =
    parsed.supported && events.length > 0 && !diagnostics.hasErrors()
      ? canonicalContract(parsed, events, limits, diagnostics)
      : undefined;
  if (
    canonicalCandidate !== undefined &&
    !validateCanonicalOutput(canonicalCandidate, diagnostics)
  ) {
    canonicalCandidate = undefined;
  }
  const collected = diagnostics.toArray();
  const status = statusFor(collected, parsed.supported);
  const contract =
    includeCanonical && status !== "invalid" ? canonicalCandidate : undefined;
  return {
    diagnostics: collected,
    parsed,
    status,
    ...(contract === undefined
      ? {}
      : { contract, export: canonicalExport(parsed, contract) }),
  };
}

export function validateContract(
  input: ContractInput | ParsedContract,
  options: ContractOptions = {},
): ContractValidationResult {
  const result = processContract(input, options, false);
  return {
    diagnostics: result.diagnostics,
    parsed: result.parsed,
    status: result.status,
  };
}

export function importContract(
  input: ContractInput,
  options: ContractOptions = {},
): ContractImportResult {
  return processContract(input, options, true);
}

export function canonicalizeContract(
  input: ContractInput | ParsedContract,
  options: ContractOptions = {},
): ContractImportResult {
  return processContract(input, options, true);
}
