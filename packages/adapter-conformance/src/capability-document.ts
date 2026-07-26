// SPDX-License-Identifier: Apache-2.0

import {
  ADAPTER_CAPABILITY_SCHEMA_ID,
  ADAPTER_CAPABILITY_SCHEMA_VERSION,
  ADAPTER_OPERATIONS,
  ADAPTER_SDK_VERSION,
  isSideEffectingOperation,
  isWellFormedUnicode,
  type AdapterOperation,
} from "@webhook-portal/adapter-sdk";

import { canonicalValue } from "./assertions.js";

const capabilityOperations = new Set<string>(ADAPTER_OPERATIONS);
const capabilityStatuses = new Set<string>([
  "degraded",
  "supported",
  "unsupported",
]);
const idempotencyStatuses = new Set<string>([
  "not_applicable",
  "required",
  "supported",
]);
const maximumIdentityLength = 256;
const maximumReasonLength = 2_048;
const maximumConstraintCount = 64;
const maximumConstraintKeyLength = 128;
const maximumConstraintStringLength = 2_048;
const maximumConstraintArrayLength = 64;
const unsafeText = /[\u0000-\u001f\u007f]/u;

function inspectClosedObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  issues: string[],
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object.`);
    return undefined;
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const result = Object.create(null) as Record<string, unknown>;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push(`${path} must be a plain object.`);
    }
    const ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      if (typeof key !== "string") {
        issues.push(`${path} must not contain symbol fields.`);
        continue;
      }
      if (!allowed.has(key)) {
        issues.push(`${path} has unknown field ${key}.`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        issues.push(`${path}.${key} must be an enumerable data property.`);
        continue;
      }
      result[key] = descriptor.value;
    }
    for (const key of requiredKeys) {
      if (!Object.hasOwn(value, key)) {
        issues.push(`${path} is missing required field ${key}.`);
      }
    }
  } catch {
    issues.push(`${path} could not be safely inspected.`);
    return undefined;
  }
  return result;
}

function inspectArray(
  value: unknown,
  path: string,
  maximumLength: number,
  issues: string[],
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array.`);
    return undefined;
  }
  if (value.length > maximumLength) {
    issues.push(`${path} exceeds its maximum length.`);
    return undefined;
  }
  const result: unknown[] = [];
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      issues.push(`${path} must be a plain array.`);
    }
    const expectedIndexes = new Set(
      Array.from({ length: value.length }, (_unused, index) => String(index)),
    );
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") {
        continue;
      }
      if (typeof key !== "string" || !expectedIndexes.has(key)) {
        issues.push(`${path} contains an unknown array field.`);
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        issues.push(`${path}[${index}] must be an enumerable data property.`);
        result.push(undefined);
      } else {
        result.push(descriptor.value);
      }
    }
  } catch {
    issues.push(`${path} could not be safely inspected.`);
    return undefined;
  }
  return result;
}

function validateSafeString(
  value: unknown,
  path: string,
  maximumLength: number,
  issues: string[],
  allowEmpty = false,
): value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength ||
    !isWellFormedUnicode(value) ||
    unsafeText.test(value)
  ) {
    issues.push(`${path} must be a bounded safe string.`);
    return false;
  }
  return true;
}

function validateConstraintScalar(
  value: unknown,
  path: string,
  issues: string[],
): "number" | "string" | undefined {
  if (typeof value === "boolean") {
    issues.push(`${path} must be a bounded JSON constraint scalar.`);
    return undefined;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  ) {
    return "number";
  }
  if (typeof value === "string") {
    return validateSafeString(
      value,
      path,
      maximumConstraintStringLength,
      issues,
      true,
    )
      ? "string"
      : undefined;
  }
  issues.push(`${path} must be a bounded JSON constraint scalar.`);
  return undefined;
}

function validateConstraints(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object.`);
    return;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push(`${path} must be a plain object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumConstraintCount) {
      issues.push(`${path} has too many entries.`);
      return;
    }
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        !validateSafeString(
          key,
          `${path} key`,
          maximumConstraintKeyLength,
          issues,
        )
      ) {
        if (typeof key !== "string") {
          issues.push(`${path} must not contain symbol fields.`);
        }
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        issues.push(`${path}.${key} must be an enumerable data property.`);
        continue;
      }
      const constraint = descriptor.value;
      if (typeof constraint === "boolean") {
        continue;
      }
      if (Array.isArray(constraint)) {
        const entries = inspectArray(
          constraint,
          `${path}.${key}`,
          maximumConstraintArrayLength,
          issues,
        );
        if (entries === undefined || entries.length === 0) {
          continue;
        }
        let scalarType: "number" | "string" | undefined;
        for (let index = 0; index < entries.length; index += 1) {
          const entryType = validateConstraintScalar(
            entries[index],
            `${path}.${key}[${index}]`,
            issues,
          );
          if (entryType === undefined) {
            continue;
          }
          scalarType ??= entryType;
          if (entryType !== scalarType) {
            issues.push(`${path}.${key} must contain one scalar type.`);
          }
        }
        continue;
      }
      validateConstraintScalar(constraint, `${path}.${key}`, issues);
    }
  } catch {
    issues.push(`${path} could not be safely inspected.`);
  }
}

function validateCapabilityStructure(
  value: unknown,
  path: string,
  issues: string[],
): Readonly<Record<string, unknown>> | undefined {
  const capability = inspectClosedObject(
    value,
    path,
    ["idempotency", "operation", "sideEffecting", "status"],
    ["constraints", "reason"],
    issues,
  );
  if (capability === undefined) {
    return undefined;
  }
  if (
    typeof capability["operation"] !== "string" ||
    !capabilityOperations.has(capability["operation"])
  ) {
    issues.push(`${path}.operation is invalid.`);
  }
  if (
    typeof capability["status"] !== "string" ||
    !capabilityStatuses.has(capability["status"])
  ) {
    issues.push(`${path}.status is invalid.`);
  }
  if (
    typeof capability["idempotency"] !== "string" ||
    !idempotencyStatuses.has(capability["idempotency"])
  ) {
    issues.push(`${path}.idempotency is invalid.`);
  }
  if (typeof capability["sideEffecting"] !== "boolean") {
    issues.push(`${path}.sideEffecting must be boolean.`);
  }
  if (
    Object.hasOwn(capability, "reason") &&
    !validateSafeString(
      capability["reason"],
      `${path}.reason`,
      maximumReasonLength,
      issues,
      true,
    )
  ) {
    // validateSafeString records the structural issue.
  }
  if (Object.hasOwn(capability, "constraints")) {
    validateConstraints(
      capability["constraints"],
      `${path}.constraints`,
      issues,
    );
  }
  return capability;
}

function validateCapabilityDocumentValue(document: unknown): readonly string[] {
  const structure = validateCapabilityDocumentStructure(document);
  if (!structure.ok) {
    return Object.freeze(structure.issues);
  }
  return validateCapabilityDocumentSemantics(
    structure.topLevel,
    structure.operationCapabilities,
    structure.indexedCapabilities,
  );
}

type CapabilityRecord = Readonly<Record<string, unknown>>;

type CapabilityDocumentStructure =
  | {
      readonly ok: false;
      readonly issues: readonly string[];
    }
  | {
      readonly ok: true;
      readonly topLevel: CapabilityRecord;
      readonly operationCapabilities: ReadonlyMap<
        AdapterOperation,
        CapabilityRecord
      >;
      readonly indexedCapabilities: ReadonlyMap<
        AdapterOperation,
        CapabilityRecord
      >;
    };

function validateCapabilityDocumentStructure(
  document: unknown,
): CapabilityDocumentStructure {
  const structuralIssues: string[] = [];
  const topLevel = inspectClosedObject(
    document,
    "The capability document",
    [
      "$schema",
      "adapter",
      "capabilities",
      "kind",
      "operations",
      "schemaVersion",
      "sdkVersion",
    ],
    ["generatedAt"],
    structuralIssues,
  );
  if (topLevel === undefined) {
    return { ok: false, issues: Object.freeze(structuralIssues) };
  }
  if (topLevel["$schema"] !== ADAPTER_CAPABILITY_SCHEMA_ID) {
    structuralIssues.push(
      "The capability document schema identifier is invalid.",
    );
  }
  if (topLevel["kind"] !== "adapter_capabilities") {
    structuralIssues.push("The capability document kind is invalid.");
  }
  if (topLevel["schemaVersion"] !== ADAPTER_CAPABILITY_SCHEMA_VERSION) {
    structuralIssues.push("The capability document schema version is invalid.");
  }
  if (topLevel["sdkVersion"] !== ADAPTER_SDK_VERSION) {
    structuralIssues.push("The capability document SDK version is invalid.");
  }

  validateCapabilityDocumentAdapter(topLevel, structuralIssues);

  const operationEntries = inspectArray(
    topLevel["operations"],
    "The capability document operations",
    ADAPTER_OPERATIONS.length,
    structuralIssues,
  );
  if (
    operationEntries !== undefined &&
    operationEntries.length !== ADAPTER_OPERATIONS.length
  ) {
    structuralIssues.push(
      "The capability document must declare every operation.",
    );
  }
  const operationCapabilities = new Map<
    AdapterOperation,
    Readonly<Record<string, unknown>>
  >();
  const operationCounts = new Map<AdapterOperation, number>();
  for (const [index, value] of (operationEntries ?? []).entries()) {
    const capability = validateCapabilityStructure(
      value,
      `The capability document operations[${index}]`,
      structuralIssues,
    );
    const operation = capability?.["operation"];
    if (
      capability !== undefined &&
      typeof operation === "string" &&
      capabilityOperations.has(operation)
    ) {
      const typedOperation = operation as AdapterOperation;
      operationCounts.set(
        typedOperation,
        (operationCounts.get(typedOperation) ?? 0) + 1,
      );
      operationCapabilities.set(typedOperation, capability);
    }
  }
  for (const operation of ADAPTER_OPERATIONS) {
    const count = operationCounts.get(operation) ?? 0;
    if (count === 0) {
      structuralIssues.push(`${operation} is missing.`);
    } else if (count > 1) {
      structuralIssues.push(`${operation} is declared more than once.`);
    }
  }

  const capabilities = inspectClosedObject(
    topLevel["capabilities"],
    "The capability document capabilities",
    ADAPTER_OPERATIONS,
    [],
    structuralIssues,
  );
  const indexedCapabilities = new Map<
    AdapterOperation,
    Readonly<Record<string, unknown>>
  >();
  if (capabilities !== undefined) {
    for (const operation of ADAPTER_OPERATIONS) {
      const capability = validateCapabilityStructure(
        capabilities[operation],
        `The capability document capabilities.${operation}`,
        structuralIssues,
      );
      if (capability !== undefined) {
        indexedCapabilities.set(operation, capability);
      }
    }
  }

  if (structuralIssues.length > 0) {
    return { ok: false, issues: Object.freeze(structuralIssues) };
  }
  return {
    ok: true,
    topLevel,
    operationCapabilities,
    indexedCapabilities,
  };
}

function validateCapabilityDocumentAdapter(
  topLevel: CapabilityRecord,
  structuralIssues: string[],
): void {
  const adapter = inspectClosedObject(
    topLevel["adapter"],
    "The capability document adapter",
    ["id", "name", "version"],
    ["homepage", "vendor"],
    structuralIssues,
  );
  if (adapter !== undefined) {
    for (const field of ["id", "name", "version"] as const) {
      validateSafeString(
        adapter[field],
        `The capability document adapter.${field}`,
        maximumIdentityLength,
        structuralIssues,
      );
    }
    for (const field of ["homepage", "vendor"] as const) {
      if (Object.hasOwn(adapter, field)) {
        validateSafeString(
          adapter[field],
          `The capability document adapter.${field}`,
          maximumIdentityLength,
          structuralIssues,
          true,
        );
      }
    }
  }
  if (
    Object.hasOwn(topLevel, "generatedAt") &&
    !validateSafeString(
      topLevel["generatedAt"],
      "The capability document generatedAt",
      128,
      structuralIssues,
    )
  ) {
    // validateSafeString records the structural issue.
  }
}

function validateCapabilityDocumentSemantics(
  topLevel: CapabilityRecord,
  operationCapabilities: ReadonlyMap<AdapterOperation, CapabilityRecord>,
  indexedCapabilities: ReadonlyMap<AdapterOperation, CapabilityRecord>,
): readonly string[] {
  const issues: string[] = [];
  if (
    typeof topLevel["generatedAt"] === "string" &&
    !Number.isFinite(Date.parse(topLevel["generatedAt"]))
  ) {
    issues.push("The capability document generatedAt is invalid.");
  }
  for (const operation of ADAPTER_OPERATIONS) {
    const capability = operationCapabilities.get(operation);
    const indexed = indexedCapabilities.get(operation);
    if (capability === undefined || indexed === undefined) {
      continue;
    }
    if (canonicalValue(indexed) !== canonicalValue(capability)) {
      issues.push(`${operation} differs between indexes.`);
    }
    if (capability["sideEffecting"] !== isSideEffectingOperation(operation)) {
      issues.push(`${operation} misstates side effects.`);
    }
    if (
      capability["sideEffecting"] === true &&
      capability["idempotency"] !== "required"
    ) {
      issues.push(`${operation} must require idempotency.`);
    }
  }
  if (
    !ADAPTER_OPERATIONS.includes("secret.rotate_with_overlap") ||
    (ADAPTER_OPERATIONS as readonly string[]).includes("secret.rotate-overlap")
  ) {
    issues.push("The secret overlap operation name violates the frozen API.");
  }
  return Object.freeze(issues);
}

export function validateCapabilityDocument(
  document: unknown,
): readonly string[] {
  try {
    return validateCapabilityDocumentValue(document);
  } catch {
    return Object.freeze([
      "The capability document could not be safely inspected.",
    ]);
  }
}
