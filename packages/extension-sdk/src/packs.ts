// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  cloneJson,
  compareUtf16CodeUnits,
  parseCanonicalJson,
  type JsonValue,
} from "./canonical.js";
import {
  type BundleVerificationResult,
  type ExtensionBundle,
} from "./bundle.js";
import { ExtensionValidationError } from "./errors.js";
import { parsePolicyProgram, type PolicyProgram } from "./policy.js";
import { parseTransformProgram, type TransformProgram } from "./transform.js";
import {
  DANGEROUS_PROPERTY_NAMES,
  expectBoolean,
  expectEnum,
  expectInteger,
  expectString,
  inspectArray,
  inspectClosedObject,
  inspectRecord,
} from "./validation.js";

export interface ConnectorConfigurationPack {
  readonly configurationSchema: JsonValue;
  readonly templates: Readonly<Record<string, string>>;
}

export interface TemplatePack {
  readonly templates: Readonly<
    Record<
      string,
      {
        readonly content: string;
        readonly mediaType:
          "text/markdown" | "text/plain" | "text/x-webhook-template";
      }
    >
  >;
}

function verifiedBundle(
  verification: BundleVerificationResult,
): ExtensionBundle {
  if (!verification.ok || verification.bundle === undefined) {
    throw new ExtensionValidationError(
      "UNVERIFIED_BUNDLE",
      "Declarative packs may only be loaded from a verified bundle.",
      "bundle",
    );
  }
  return verification.bundle;
}

function assetContent(bundle: ExtensionBundle, path: string): string {
  const asset = bundle.assets.find((candidate) => candidate.path === path);
  if (asset === undefined) {
    throw new ExtensionValidationError(
      "MISSING_ENTRY_ASSET",
      `Verified bundle is missing entry asset ${path}.`,
      path,
    );
  }
  return asset.content;
}

const CONFIGURATION_SCHEMA_KEYS = [
  "$schema",
  "additionalProperties",
  "const",
  "default",
  "description",
  "enum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "properties",
  "required",
  "title",
  "type",
] as const;

function validateSchema(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
): JsonValue {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 32) {
    throw new ExtensionValidationError(
      "SCHEMA_LIMIT",
      "Configuration schema exceeds node or depth limits.",
      path,
    );
  }
  const object = inspectClosedObject(
    value,
    path,
    [],
    [...CONFIGURATION_SCHEMA_KEYS],
  );
  const result = Object.create(null) as Record<string, JsonValue>;
  if (object.$schema !== undefined) {
    const schema = expectString(object.$schema, `${path}.$schema`, {
      maximumLength: 256,
    });
    if (
      schema !== "https://json-schema.org/draft/2020-12/schema" &&
      schema !== "https://json-schema.org/draft/2020-12/schema#"
    ) {
      throw new ExtensionValidationError(
        "UNSUPPORTED_SCHEMA_DIALECT",
        "Only JSON Schema draft 2020-12 is supported.",
        `${path}.$schema`,
      );
    }
    result.$schema = schema;
  }
  if (object.type !== undefined) {
    result.type = expectEnum(object.type, `${path}.type`, [
      "array",
      "boolean",
      "integer",
      "null",
      "number",
      "object",
      "string",
    ] as const);
  }
  for (const key of ["title", "description"] as const) {
    if (object[key] !== undefined) {
      result[key] = expectString(object[key], `${path}.${key}`, {
        maximumLength: key === "description" ? 4_096 : 256,
      });
    }
  }
  if (object.format !== undefined) {
    result.format = expectEnum(object.format, `${path}.format`, [
      "date",
      "date-time",
      "email",
      "hostname",
      "uri",
      "uuid",
    ] as const);
  }
  for (const key of [
    "maxItems",
    "maxLength",
    "minItems",
    "minLength",
  ] as const) {
    if (object[key] !== undefined) {
      result[key] = expectInteger(object[key], `${path}.${key}`, 0, 100_000);
    }
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (
      object[key] !== undefined &&
      (typeof object[key] !== "number" || !Number.isFinite(object[key]))
    ) {
      throw new ExtensionValidationError(
        "INVALID_SCHEMA_NUMBER",
        `${path}.${key} must be a finite number.`,
        `${path}.${key}`,
      );
    }
    if (object[key] !== undefined) {
      result[key] = object[key] as number;
    }
  }
  if (object.additionalProperties !== undefined) {
    if (
      expectBoolean(
        object.additionalProperties,
        `${path}.additionalProperties`,
      ) !== false
    ) {
      throw new ExtensionValidationError(
        "OPEN_CONFIGURATION_SCHEMA",
        "Configuration object schemas must set additionalProperties=false.",
        `${path}.additionalProperties`,
      );
    }
    result.additionalProperties = false;
  }
  if (object.required !== undefined) {
    const required = inspectArray(object.required, `${path}.required`, 256).map(
      (candidate, index) =>
        expectString(candidate, `${path}.required[${index}]`, {
          maximumLength: 256,
        }),
    );
    result.required = Object.freeze(
      [...new Set(required)].sort(compareUtf16CodeUnits),
    );
  }
  if (object.properties !== undefined) {
    const properties = inspectRecord(object.properties, `${path}.properties`, {
      maximumEntries: 256,
    });
    const parsed = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(properties).sort(compareUtf16CodeUnits)) {
      if (
        key.length === 0 ||
        key.length > 256 ||
        DANGEROUS_PROPERTY_NAMES.has(key)
      ) {
        throw new ExtensionValidationError(
          "DANGEROUS_SCHEMA_PROPERTY",
          `${path}.properties contains an unsafe property name.`,
          `${path}.properties`,
        );
      }
      parsed[key] = validateSchema(
        properties[key],
        `${path}.properties.${key}`,
        depth + 1,
        state,
      );
    }
    result.properties = parsed;
  }
  if (object.items !== undefined) {
    result.items = validateSchema(
      object.items,
      `${path}.items`,
      depth + 1,
      state,
    );
  }
  for (const key of ["const", "default"] as const) {
    if (object[key] !== undefined) {
      canonicalJson(object[key] as JsonValue, {
        maximumDepth: 32,
        maximumOutputBytes: 1024 * 1024,
      });
      result[key] = cloneJson(object[key] as JsonValue);
    }
  }
  if (object.enum !== undefined) {
    result.enum = inspectArray(object.enum, `${path}.enum`, 256).map(
      (candidate) => {
        canonicalJson(candidate as JsonValue, {
          maximumDepth: 32,
          maximumOutputBytes: 1024 * 1024,
        });
        return cloneJson(candidate as JsonValue);
      },
    );
  }
  if (
    (result.type === "object" || result.properties !== undefined) &&
    result.additionalProperties !== false
  ) {
    throw new ExtensionValidationError(
      "OPEN_CONFIGURATION_SCHEMA",
      "Configuration object schemas must explicitly set additionalProperties=false.",
      `${path}.additionalProperties`,
    );
  }
  if (Array.isArray(result.required)) {
    const propertyNames =
      result.properties === undefined
        ? new Set<string>()
        : new Set(Object.keys(result.properties as object));
    for (const required of result.required) {
      if (typeof required !== "string" || !propertyNames.has(required)) {
        throw new ExtensionValidationError(
          "UNKNOWN_REQUIRED_PROPERTY",
          `${path}.required names a property absent from properties.`,
          `${path}.required`,
        );
      }
    }
  }
  if (result.type === "array" && result.items === undefined) {
    throw new ExtensionValidationError(
      "OPEN_CONFIGURATION_SCHEMA",
      "Configuration array schemas must declare an items schema.",
      `${path}.items`,
    );
  }
  return Object.freeze(result);
}

export function validateConfigurationSchema(value: unknown): JsonValue {
  return validateSchema(value, "schema", 0, { nodes: 0 });
}

export function loadConnectorPack(
  verification: BundleVerificationResult,
): ConnectorConfigurationPack {
  const bundle = verifiedBundle(verification);
  if (
    bundle.manifest.kind !== "connector" ||
    bundle.manifest.entry.type !== "connector"
  ) {
    throw new ExtensionValidationError(
      "WRONG_EXTENSION_KIND",
      "Bundle is not a connector configuration pack.",
    );
  }
  const schema = validateConfigurationSchema(
    parseCanonicalJson(
      assetContent(bundle, bundle.manifest.entry.configurationSchema),
    ),
  );
  const templates = Object.create(null) as Record<string, string>;
  for (const templatePath of bundle.manifest.entry.templates) {
    templates[templatePath] = assetContent(bundle, templatePath);
  }
  return Object.freeze({
    configurationSchema: schema,
    templates: Object.freeze(templates),
  });
}

export function loadTemplatePack(
  verification: BundleVerificationResult,
): TemplatePack {
  const bundle = verifiedBundle(verification);
  if (
    bundle.manifest.kind !== "template" ||
    bundle.manifest.entry.type !== "template"
  ) {
    throw new ExtensionValidationError(
      "WRONG_EXTENSION_KIND",
      "Bundle is not a template pack.",
    );
  }
  const templates = Object.create(null) as Record<
    string,
    {
      readonly content: string;
      readonly mediaType:
        "text/markdown" | "text/plain" | "text/x-webhook-template";
    }
  >;
  for (const declaration of bundle.manifest.entry.templates) {
    templates[declaration.name] = Object.freeze({
      content: assetContent(bundle, declaration.path),
      mediaType: declaration.mediaType,
    });
  }
  return Object.freeze({ templates: Object.freeze(templates) });
}

export function loadTransformProgram(
  verification: BundleVerificationResult,
): TransformProgram {
  const bundle = verifiedBundle(verification);
  if (
    bundle.manifest.kind !== "transform" ||
    bundle.manifest.entry.type !== "transform"
  ) {
    throw new ExtensionValidationError(
      "WRONG_EXTENSION_KIND",
      "Bundle is not a transform pack.",
    );
  }
  return parseTransformProgram(
    parseCanonicalJson(assetContent(bundle, bundle.manifest.entry.program)),
  );
}

export function loadPolicyProgram(
  verification: BundleVerificationResult,
): PolicyProgram {
  const bundle = verifiedBundle(verification);
  if (
    bundle.manifest.kind !== "policy" ||
    bundle.manifest.entry.type !== "policy"
  ) {
    throw new ExtensionValidationError(
      "WRONG_EXTENSION_KIND",
      "Bundle is not a policy pack.",
    );
  }
  return parsePolicyProgram(
    parseCanonicalJson(assetContent(bundle, bundle.manifest.entry.program)),
  );
}
