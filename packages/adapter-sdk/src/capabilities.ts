// SPDX-License-Identifier: Apache-2.0

export const ADAPTER_SDK_VERSION = "1.0.0" as const;
export const ADAPTER_CAPABILITY_SCHEMA_VERSION = "2026-07-01" as const;
export const ADAPTER_CAPABILITY_SCHEMA_ID =
  "https://webhook-portal.dev/schemas/adapter-capabilities/2026-07-01" as const;

export const ADAPTER_OPERATIONS = [
  "endpoint.create",
  "endpoint.read",
  "endpoint.update",
  "endpoint.pause",
  "endpoint.resume",
  "endpoint.delete",
  "endpoint.verify",
  "subscription.read",
  "subscription.replace",
  "subscription.pause",
  "subscription.resume",
  "secret.create",
  "secret.rotate_with_overlap",
  "secret.revoke",
  "send_test",
  "request_replay",
  "metadata.poll",
  "metadata.backfill",
] as const;

export type AdapterOperation = (typeof ADAPTER_OPERATIONS)[number];

export const SIDE_EFFECTING_ADAPTER_OPERATIONS = [
  "endpoint.create",
  "endpoint.update",
  "endpoint.pause",
  "endpoint.resume",
  "endpoint.delete",
  "endpoint.verify",
  "subscription.replace",
  "subscription.pause",
  "subscription.resume",
  "secret.create",
  "secret.rotate_with_overlap",
  "secret.revoke",
  "send_test",
  "request_replay",
] as const satisfies readonly AdapterOperation[];

const sideEffectingOperations = new Set<AdapterOperation>(
  SIDE_EFFECTING_ADAPTER_OPERATIONS,
);

export type AdapterCapabilityStatus = "degraded" | "supported" | "unsupported";

export type IdempotencySupport = "not_applicable" | "required" | "supported";

export type CapabilityConstraintValue =
  boolean | number | string | readonly number[] | readonly string[];

export interface AdapterCapability {
  readonly constraints?: Readonly<Record<string, CapabilityConstraintValue>>;
  readonly idempotency: IdempotencySupport;
  readonly operation: AdapterOperation;
  readonly reason?: string;
  readonly sideEffecting: boolean;
  readonly status: AdapterCapabilityStatus;
}

export interface AdapterIdentity {
  readonly homepage?: string;
  readonly id: string;
  readonly name: string;
  readonly vendor?: string;
  readonly version: string;
}

export interface AdapterCapabilityDocument {
  readonly $schema: typeof ADAPTER_CAPABILITY_SCHEMA_ID;
  readonly adapter: AdapterIdentity;
  readonly capabilities: Readonly<Record<AdapterOperation, AdapterCapability>>;
  readonly generatedAt?: string;
  readonly kind: "adapter_capabilities";
  readonly operations: readonly AdapterCapability[];
  readonly schemaVersion: typeof ADAPTER_CAPABILITY_SCHEMA_VERSION;
  readonly sdkVersion: typeof ADAPTER_SDK_VERSION;
}

export type AdapterCapabilityDeclaration =
  | AdapterCapabilityStatus
  | (Omit<AdapterCapability, "idempotency" | "operation" | "sideEffecting"> & {
      readonly idempotency?: IdempotencySupport;
      readonly sideEffecting?: boolean;
    });

export interface CreateCapabilityDocumentInput {
  readonly adapter: AdapterIdentity;
  readonly capabilities?: Partial<
    Record<AdapterOperation, AdapterCapabilityDeclaration>
  >;
  readonly generatedAt?: string;
}

function validateIdentity(identity: AdapterIdentity): void {
  for (const [name, value] of [
    ["adapter.id", identity.id],
    ["adapter.name", identity.name],
    ["adapter.version", identity.version],
  ] as const) {
    if (
      value.length === 0 ||
      value.length > 256 ||
      !isWellFormedUnicode(value) ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new RangeError(`${name} must be a non-empty safe string.`);
    }
  }
}

function capabilityForDeclaration(
  operation: AdapterOperation,
  declaration: AdapterCapabilityDeclaration | undefined,
): AdapterCapability {
  const sideEffecting = sideEffectingOperations.has(operation);
  const status =
    typeof declaration === "string"
      ? declaration
      : (declaration?.status ?? "unsupported");
  const reason =
    typeof declaration === "string" ? undefined : declaration?.reason;
  const constraints =
    typeof declaration === "string" ? undefined : declaration?.constraints;
  const declaredSideEffects =
    typeof declaration === "string" ? undefined : declaration?.sideEffecting;
  const declaredIdempotency =
    typeof declaration === "string" ? undefined : declaration?.idempotency;
  if (
    declaredSideEffects !== undefined &&
    declaredSideEffects !== sideEffecting
  ) {
    throw new RangeError(
      `${operation} cannot override the SDK side-effect classification.`,
    );
  }
  if (
    sideEffecting &&
    declaredIdempotency !== undefined &&
    declaredIdempotency !== "required"
  ) {
    throw new RangeError(
      `${operation} requires idempotency in the adapter contract.`,
    );
  }

  return Object.freeze({
    operation,
    status,
    sideEffecting,
    idempotency:
      declaredIdempotency ??
      (sideEffecting ? ("required" as const) : ("not_applicable" as const)),
    ...(reason === undefined ? {} : { reason }),
    ...(constraints === undefined
      ? {}
      : { constraints: Object.freeze({ ...constraints }) }),
  });
}

export function createCapabilityDocument(
  input: CreateCapabilityDocumentInput,
): AdapterCapabilityDocument {
  validateIdentity(input.adapter);
  if (
    input.generatedAt !== undefined &&
    !Number.isFinite(Date.parse(input.generatedAt))
  ) {
    throw new RangeError("generatedAt must be a valid date-time.");
  }

  const operations = ADAPTER_OPERATIONS.map((operation) =>
    capabilityForDeclaration(operation, input.capabilities?.[operation]),
  );
  const capabilities = Object.fromEntries(
    operations.map((capability) => [capability.operation, capability]),
  ) as Record<AdapterOperation, AdapterCapability>;

  return Object.freeze({
    $schema: ADAPTER_CAPABILITY_SCHEMA_ID,
    kind: "adapter_capabilities",
    schemaVersion: ADAPTER_CAPABILITY_SCHEMA_VERSION,
    sdkVersion: ADAPTER_SDK_VERSION,
    adapter: Object.freeze({ ...input.adapter }),
    capabilities: Object.freeze(capabilities),
    operations: Object.freeze(operations),
    ...(input.generatedAt === undefined
      ? {}
      : { generatedAt: input.generatedAt }),
  });
}

export function getAdapterCapability(
  document: AdapterCapabilityDocument,
  operation: AdapterOperation,
): AdapterCapability {
  return document.capabilities[operation];
}

export function supportsAdapterOperation(
  document: AdapterCapabilityDocument,
  operation: AdapterOperation,
): boolean {
  return getAdapterCapability(document, operation).status !== "unsupported";
}

export function isSideEffectingOperation(operation: AdapterOperation): boolean {
  return sideEffectingOperations.has(operation);
}
import { isWellFormedUnicode } from "./canonical.js";
