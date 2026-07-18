// SPDX-License-Identifier: Apache-2.0

import { isJsonObject, isJsonSchema, isJsonValue } from "./json.js";
import {
  CANONICAL_EXPORT_FORMAT,
  CANONICAL_EXPORT_VERSION,
  CANONICAL_MODEL_VERSION,
  CANONICAL_SCHEMA_ID,
  type CanonicalContract,
  type CanonicalContractExport,
  type ContractDiagnostic,
  type Sha256Checksum,
} from "./model.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function isSourceLocation(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Number.isInteger(value["line"]) &&
    (value["line"] as number) >= 1 &&
    Number.isInteger(value["column"]) &&
    (value["column"] as number) >= 1 &&
    (value["offset"] === undefined ||
      (Number.isInteger(value["offset"]) && (value["offset"] as number) >= 0))
  );
}

function isSourceRange(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    isSourceLocation(value["start"]) &&
    (value["end"] === undefined || isSourceLocation(value["end"]))
  );
}

function isSourcePointer(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    typeof value["pointer"] === "string" &&
    (value["location"] === undefined || isSourceRange(value["location"]))
  );
}

function isSignatureProfile(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    nonEmptyString(value["name"]) &&
    (value["version"] === undefined || typeof value["version"] === "string") &&
    (value["algorithms"] === undefined ||
      (Array.isArray(value["algorithms"]) &&
        value["algorithms"].every(nonEmptyString))) &&
    (value["headers"] === undefined ||
      (Array.isArray(value["headers"]) &&
        value["headers"].every(
          (header) =>
            isJsonObject(header) &&
            nonEmptyString(header["name"]) &&
            typeof header["required"] === "boolean",
        ))) &&
    (value["extensions"] === undefined || isJsonObject(value["extensions"]))
  );
}

function isCanonicalExample(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    nonEmptyString(value["name"]) &&
    value["value"] !== undefined &&
    isJsonValue(value["value"]) &&
    (value["description"] === undefined ||
      typeof value["description"] === "string") &&
    (value["summary"] === undefined || typeof value["summary"] === "string") &&
    (value["source"] === undefined || isSourcePointer(value["source"]))
  );
}

function isCanonicalSchemaValue(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    isSha256Checksum(value["checksum"]) &&
    nonEmptyString(value["dialect"]) &&
    isJsonSchema(value["value"]) &&
    (value["source"] === undefined || isSourcePointer(value["source"]))
  );
}

function isDeprecation(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    typeof value["deprecated"] === "boolean" &&
    (value["replacement"] === undefined ||
      typeof value["replacement"] === "string") &&
    (value["sunsetAt"] === undefined || typeof value["sunsetAt"] === "string")
  );
}

function isEventVersion(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    nonEmptyString(value["id"]) &&
    nonEmptyString(value["publicVersion"]) &&
    isCanonicalSchemaValue(value["schema"]) &&
    isSourcePointer(value["source"]) &&
    Array.isArray(value["examples"]) &&
    value["examples"].every(isCanonicalExample) &&
    (value["deprecation"] === undefined ||
      isDeprecation(value["deprecation"])) &&
    (value["description"] === undefined ||
      typeof value["description"] === "string") &&
    (value["title"] === undefined || typeof value["title"] === "string") &&
    (value["extensions"] === undefined || isJsonObject(value["extensions"])) &&
    (value["signatureProfile"] === undefined ||
      isSignatureProfile(value["signatureProfile"]))
  );
}

function isEventType(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    nonEmptyString(value["id"]) &&
    nonEmptyString(value["externalName"]) &&
    Array.isArray(value["versions"]) &&
    value["versions"].length > 0 &&
    value["versions"].every(isEventVersion) &&
    (value["description"] === undefined ||
      typeof value["description"] === "string") &&
    (value["title"] === undefined || typeof value["title"] === "string") &&
    (value["extensions"] === undefined || isJsonObject(value["extensions"]))
  );
}

function isContractSource(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    (value["format"] === "asyncapi" || value["format"] === "openapi") &&
    (value["mediaType"] === "application/json" ||
      value["mediaType"] === "application/yaml" ||
      value["mediaType"] === "text/yaml") &&
    isJsonObject(value["parser"]) &&
    nonEmptyString(value["parser"]["name"]) &&
    nonEmptyString(value["parser"]["version"]) &&
    isSha256Checksum(value["sourceChecksum"]) &&
    nonEmptyString(value["specificationVersion"]) &&
    (value["sourceUri"] === undefined ||
      typeof value["sourceUri"] === "string") &&
    (value["extensions"] === undefined || isJsonObject(value["extensions"]))
  );
}

export function isSha256Checksum(value: unknown): value is Sha256Checksum {
  return (
    isJsonObject(value) &&
    isJsonValue(value) &&
    value["algorithm"] === "sha256" &&
    typeof value["value"] === "string" &&
    sha256Pattern.test(value["value"])
  );
}

export function isContractDiagnostic(
  value: unknown,
): value is ContractDiagnostic {
  if (!isJsonObject(value) || !isJsonValue(value)) {
    return false;
  }

  const severity = value["severity"];
  return (
    (severity === "error" ||
      severity === "fatal" ||
      severity === "info" ||
      severity === "warning") &&
    typeof value["code"] === "string" &&
    value["code"].length > 0 &&
    typeof value["message"] === "string" &&
    (value["pointer"] === undefined || typeof value["pointer"] === "string") &&
    (value["details"] === undefined || isJsonObject(value["details"])) &&
    (value["source"] === undefined || isSourceRange(value["source"]))
  );
}

/**
 * Performs a deliberately structural guard. It verifies the stable envelope
 * and event/schema shape without attempting full JSON Schema validation.
 */
export function isCanonicalContract(
  value: unknown,
): value is CanonicalContract {
  if (
    !isJsonObject(value) ||
    !isJsonValue(value) ||
    value["$schema"] !== CANONICAL_SCHEMA_ID ||
    value["modelVersion"] !== CANONICAL_MODEL_VERSION ||
    typeof value["id"] !== "string" ||
    !isSha256Checksum(value["checksum"]) ||
    !isJsonObject(value["source"]) ||
    !Array.isArray(value["eventTypes"])
  ) {
    return false;
  }

  return (
    nonEmptyString(value["id"]) &&
    isContractSource(value["source"]) &&
    value["eventTypes"].length > 0 &&
    value["eventTypes"].every(isEventType) &&
    (value["title"] === undefined || typeof value["title"] === "string") &&
    (value["version"] === undefined || typeof value["version"] === "string") &&
    (value["extensions"] === undefined || isJsonObject(value["extensions"])) &&
    (value["signatureProfile"] === undefined ||
      isSignatureProfile(value["signatureProfile"]))
  );
}

export function isCanonicalContractExport(
  value: unknown,
): value is CanonicalContractExport {
  return (
    isJsonObject(value) &&
    isJsonValue(value) &&
    value["format"] === CANONICAL_EXPORT_FORMAT &&
    value["formatVersion"] === CANONICAL_EXPORT_VERSION &&
    isCanonicalContract(value["canonical"]) &&
    isJsonObject(value["checksums"]) &&
    isSha256Checksum(value["checksums"]["canonical"]) &&
    isSha256Checksum(value["checksums"]["source"]) &&
    isJsonObject(value["original"]) &&
    ((value["original"]["kind"] === "document" &&
      (value["original"]["mediaType"] === "application/json" ||
        value["original"]["mediaType"] === "application/yaml" ||
        value["original"]["mediaType"] === "text/yaml") &&
      isJsonObject(value["original"]["value"])) ||
      (value["original"]["kind"] === "text" &&
        (value["original"]["mediaType"] === "application/json" ||
          value["original"]["mediaType"] === "application/yaml" ||
          value["original"]["mediaType"] === "text/yaml") &&
        typeof value["original"]["value"] === "string"))
  );
}
