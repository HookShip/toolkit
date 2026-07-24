// SPDX-License-Identifier: Apache-2.0

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import {
  CANONICAL_EXPORT_FORMAT,
  CANONICAL_EXPORT_VERSION,
  CANONICAL_CONTRACT_JSON_SCHEMA,
  CANONICAL_MODEL_VERSION,
  CANONICAL_SCHEMA_ID,
  isCanonicalContract,
  isJsonSchema,
  type CanonicalContract,
  type CanonicalContractContent,
  type CanonicalContractExport,
  type CanonicalEventType,
  type CanonicalEventVersion,
  type ContractDiagnostic,
  type ContractImportStatus,
  type ContractSourceMetadata,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type Sha256Checksum,
} from "@webhook-portal/canonical-model";

import type { ContractLimits, ParsedContract } from "./api-types.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { validateCanonicalExamples } from "./example-validation.js";
import {
  addAt,
  locationSource,
  resolveObject,
  resolveSchema,
  schemaDialect,
  type ExtractedEvent,
  type ExtractionContext,
} from "./extraction-context.js";
import {
  asObject,
  asString,
  checksumJson,
  collectExtensions,
  compareCodeUnits,
  escapePointerToken,
  inspectJsonValue,
  joinPointer,
  jsonEqual,
  sha256,
  sortJsonValue,
  stableStringify,
} from "./json-utils.js";
import { CONTRACT_CORE_NAME, CONTRACT_CORE_VERSION } from "./parser.js";
import { signatureProfile } from "./signature-profile.js";
import { resolveAsyncApiSchemaDialect } from "./source-validation.js";

const INTERPRETED_CONTRACT_EXTENSIONS = [
  "x-contract-id",
  "x-signature-profile",
  "x-standard-webhooks",
] as const;
let canonicalOutputValidator: ValidateFunction | undefined;

export function validateDeclaredSchemas(
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

export function eventId(sourceIdentity: string): string {
  return `evt_${sha256(sourceIdentity).value.slice(0, 20)}`;
}

export function eventVersionId(id: string, publicVersion: string): string {
  return `evv_${sha256(`${id}\u0000${publicVersion}`).value.slice(0, 20)}`;
}

export function eventVersionSemantics(
  version: CanonicalEventVersion,
): JsonObject {
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

export function semanticDifferenceFields(
  previous: JsonObject,
  next: JsonObject,
): readonly string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .sort(compareCodeUnits)
    .filter((key) => !jsonEqual(previous[key] ?? null, next[key] ?? null));
}

export function mergeEvents(
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

export function statusFor(
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

export function semanticChecksumValue(
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

export function contractId(
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

export function validateTopLevelCanonicalFields(
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

export function canonicalOutputWithinLimits(
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

export function canonicalContract(
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

export function validateCanonicalOutput(
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

export function canonicalExport(
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
