// SPDX-License-Identifier: Apache-2.0

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  ADAPTER_OPERATIONS,
  assertWellFormedUnicode,
  compareUtf16CodeUnits,
  checkCredentialScope,
  createDeadlineSignal,
  isMappingVersion,
  isWellFormedUnicode,
  revealSecret,
  type AdapterJsonValue,
  type AdapterOperation,
  type MappingVersion,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

export const PROVIDER_ACKNOWLEDGEMENT_SCHEMA_VERSION = "2026-07-01" as const;
export const PROVIDER_ACKNOWLEDGEMENT_SIGNATURE_ALGORITHM =
  "hmac-sha256" as const;

export interface ProviderResourceAcknowledgement {
  readonly id: string;
  readonly state: string;
  readonly type: "endpoint" | "secret" | "subscription";
}

export type ProviderAcknowledgementResult =
  | {
      readonly kind: "resource";
      readonly resource: ProviderResourceAcknowledgement;
      readonly verified?: boolean;
    }
  | {
      readonly accepted: true;
      readonly deliveryId?: string;
      readonly kind: "test_dispatch";
    }
  | {
      readonly accepted: true;
      readonly kind: "replay";
      readonly replayId?: string;
    };

export interface ProviderAcknowledgementContent {
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly credentialId: string;
  readonly disposition: "completed" | "pending";
  readonly environment: string;
  readonly expiresAt: number;
  readonly idempotencyKey: string;
  readonly issuedAt: number;
  readonly kind: "adapter_acknowledgement";
  readonly mappingVersion: MappingVersion;
  readonly nonce: string;
  readonly operation: AdapterOperation;
  readonly requestNonce: string;
  readonly result: ProviderAcknowledgementResult;
  readonly schemaVersion: typeof PROVIDER_ACKNOWLEDGEMENT_SCHEMA_VERSION;
  readonly tenantId: string;
}

export interface AuthenticatedProviderAcknowledgement extends ProviderAcknowledgementContent {
  readonly signature: {
    readonly algorithm: typeof PROVIDER_ACKNOWLEDGEMENT_SIGNATURE_ALGORITHM;
    readonly value: string;
  };
}

export type ProviderAcknowledgement = AuthenticatedProviderAcknowledgement;

export interface AcknowledgementBinding {
  readonly adapterId: string;
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly environment: string;
  readonly expectedResourceId?: string;
  readonly idempotencyKey: string;
  readonly mappingVersion: MappingVersion;
  readonly operation: AdapterOperation;
  readonly requestNonce: string;
  readonly tenantId: string;
}

export interface CreateProviderAcknowledgementOptions {
  readonly expiresAt?: number;
  readonly issuedAt?: number;
  readonly maximumLifetimeMilliseconds?: number;
  readonly nonce?: string;
}

export interface AcknowledgementReplayInput {
  readonly commandFingerprint: string;
  readonly credentialId: string;
  readonly deadlineAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly requestNonce: string;
  readonly signal: AbortSignal;
}

/**
 * consume must atomically return true only for the first observation. Durable
 * implementations should be shared by all adapter instances.
 */
export interface AcknowledgementReplayStore {
  consume(input: AcknowledgementReplayInput): Promise<boolean>;
}

export interface InMemoryAcknowledgementReplayStoreOptions {
  readonly clock?: () => number;
  readonly maxEntries?: number;
}

export class InMemoryAcknowledgementReplayStore implements AcknowledgementReplayStore {
  readonly #clock: () => number;
  readonly #maxEntries: number;
  readonly #seen = new Map<string, number>();

  constructor(options: InMemoryAcknowledgementReplayStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer.");
    }
  }

  async consume(input: AcknowledgementReplayInput): Promise<boolean> {
    if (input.signal.aborted || input.deadlineAt <= this.#clock()) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new DOMException(
            "The acknowledgement replay deadline expired.",
            "AbortError",
          );
    }
    this.purgeExpired();
    const key = [
      input.credentialId,
      input.nonce,
      input.requestNonce,
      input.commandFingerprint,
    ]
      .map((part) => `${part.length}:${part}`)
      .join("");
    if (this.#seen.has(key) || this.#seen.size >= this.#maxEntries) {
      return false;
    }
    this.#seen.set(key, input.expiresAt);
    return true;
  }

  purgeExpired(now = this.#clock()): number {
    let removed = 0;
    for (const [key, expiresAt] of this.#seen) {
      if (expiresAt <= now) {
        this.#seen.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export type AcknowledgementVerificationResult =
  | {
      readonly acknowledgement: AuthenticatedProviderAcknowledgement;
      readonly ok: true;
    }
  | {
      readonly code: string;
      readonly message: string;
      readonly ok: false;
    };

const contentFields = new Set([
  "commandFingerprint",
  "connectionId",
  "credentialId",
  "disposition",
  "environment",
  "expiresAt",
  "idempotencyKey",
  "issuedAt",
  "kind",
  "mappingVersion",
  "nonce",
  "operation",
  "requestNonce",
  "result",
  "schemaVersion",
  "tenantId",
]);
const envelopeFields = new Set([...contentFields, "signature"]);
const resourceFields = new Set(["id", "state", "type"]);
const mappingFields = new Set(["name", "schemaVersion", "version"]);
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const signaturePattern = /^[A-Za-z0-9_-]{43}$/u;
const operationSet = new Set<string>(ADAPTER_OPERATIONS);

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function onlyKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
): value is Readonly<Record<string, unknown>> {
  return (
    isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function exactKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
): value is Readonly<Record<string, unknown>> {
  return onlyKeys(value, allowed) && Object.keys(value).length === allowed.size;
}

function safeString(value: unknown, maximum = 2_048): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    isWellFormedUnicode(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function stableJson(value: AdapterJsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${stableJson(item as AdapterJsonValue)}`,
      )
      .join(",")}}`;
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
  }
  return JSON.stringify(value);
}

function asJson(value: unknown): AdapterJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (typeof value === "string") {
      assertWellFormedUnicode(value);
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => asJson(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => {
          assertWellFormedUnicode(key, "Acknowledgement object key");
          return [key, asJson(item)] as const;
        })
        .sort(([left], [right]) => compareUtf16CodeUnits(left, right)),
    );
  }
  throw new TypeError("Acknowledgement content must be JSON-compatible.");
}

function signingContent(content: ProviderAcknowledgementContent): string {
  return stableJson(
    asJson({
      kind: content.kind,
      schemaVersion: content.schemaVersion,
      credentialId: content.credentialId,
      issuedAt: content.issuedAt,
      expiresAt: content.expiresAt,
      nonce: content.nonce,
      requestNonce: content.requestNonce,
      operation: content.operation,
      connectionId: content.connectionId,
      tenantId: content.tenantId,
      environment: content.environment,
      commandFingerprint: content.commandFingerprint,
      idempotencyKey: content.idempotencyKey,
      mappingVersion: content.mappingVersion,
      disposition: content.disposition,
      result: content.result,
    }),
  );
}

export function computeProviderAcknowledgementSignature(
  content: ProviderAcknowledgementContent,
  credential: ScopedCredential,
): string {
  return createHmac("sha256", revealSecret(credential.secret))
    .update(signingContent(content), "utf8")
    .digest("base64url");
}

function expectedResourceType(
  operation: AdapterOperation,
): ProviderResourceAcknowledgement["type"] | undefined {
  if (operation.startsWith("endpoint.")) {
    return "endpoint";
  }
  if (operation.startsWith("subscription.")) {
    return "subscription";
  }
  if (operation.startsWith("secret.")) {
    return "secret";
  }
  return undefined;
}

function allowedCompletedStates(
  operation: AdapterOperation,
): ReadonlySet<string> {
  switch (operation) {
    case "endpoint.create":
    case "endpoint.resume":
      return new Set(["active"]);
    case "endpoint.pause":
      return new Set(["paused"]);
    case "endpoint.delete":
      return new Set(["deleted"]);
    case "endpoint.read":
      return new Set(["active", "deleted", "paused"]);
    case "endpoint.update":
    case "endpoint.verify":
      return new Set(["active", "paused"]);
    case "subscription.replace":
    case "subscription.resume":
      return new Set(["active"]);
    case "subscription.pause":
      return new Set(["paused"]);
    case "subscription.read":
      return new Set(["active", "paused"]);
    case "secret.create":
      return new Set(["active"]);
    case "secret.rotate_with_overlap":
      return new Set(["overlapping"]);
    case "secret.revoke":
      return new Set(["revoked"]);
    default:
      return new Set();
  }
}

function validateResult(
  operation: AdapterOperation,
  disposition: "completed" | "pending",
  value: unknown,
  expectedResourceId?: string,
): ProviderAcknowledgementResult | undefined {
  const resourceType = expectedResourceType(operation);
  if (resourceType !== undefined) {
    const allowed = new Set(["kind", "resource"]);
    if (operation === "endpoint.verify") {
      allowed.add("verified");
    }
    if (
      !onlyKeys(value, allowed) ||
      value["kind"] !== "resource" ||
      !exactKeys(value["resource"], resourceFields) ||
      value["resource"]["type"] !== resourceType ||
      !safeString(value["resource"]["id"]) ||
      !safeString(value["resource"]["state"]) ||
      (expectedResourceId !== undefined &&
        value["resource"]["id"] !== expectedResourceId)
    ) {
      return undefined;
    }
    const states =
      disposition === "pending"
        ? new Set(["pending"])
        : allowedCompletedStates(operation);
    if (!states.has(value["resource"]["state"] as string)) {
      return undefined;
    }
    if (
      operation === "endpoint.verify" &&
      typeof value["verified"] !== "boolean"
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "resource",
      resource: Object.freeze({
        type: resourceType,
        id: value["resource"]["id"],
        state: value["resource"]["state"],
      }),
      ...(value["verified"] === undefined
        ? {}
        : { verified: value["verified"] as boolean }),
    });
  }
  if (operation === "send_test") {
    if (
      !onlyKeys(value, new Set(["accepted", "deliveryId", "kind"])) ||
      value["kind"] !== "test_dispatch" ||
      value["accepted"] !== true ||
      (disposition === "completed" && !safeString(value["deliveryId"])) ||
      (value["deliveryId"] !== undefined && !safeString(value["deliveryId"]))
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "test_dispatch",
      accepted: true,
      ...(value["deliveryId"] === undefined
        ? {}
        : { deliveryId: value["deliveryId"] }),
    });
  }
  if (operation === "request_replay") {
    if (
      !onlyKeys(value, new Set(["accepted", "kind", "replayId"])) ||
      value["kind"] !== "replay" ||
      value["accepted"] !== true ||
      (disposition === "completed" && !safeString(value["replayId"])) ||
      (value["replayId"] !== undefined && !safeString(value["replayId"]))
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "replay",
      accepted: true,
      ...(value["replayId"] === undefined
        ? {}
        : { replayId: value["replayId"] }),
    });
  }
  return undefined;
}

function sameMappingVersion(
  left: MappingVersion,
  right: MappingVersion,
): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.schemaVersion === right.schemaVersion
  );
}

function canonicalizeMappingVersion(
  value: unknown,
): MappingVersion | undefined {
  if (!isMappingVersion(value) || !onlyKeys(value, mappingFields)) {
    return undefined;
  }
  return Object.freeze({
    name: value.name,
    version: value.version,
    ...(value.schemaVersion === undefined
      ? {}
      : { schemaVersion: value.schemaVersion }),
  });
}

function canonicalizeAcknowledgementContent(
  value: unknown,
  expectedResourceId?: string,
): ProviderAcknowledgementContent | undefined {
  if (
    !exactKeys(value, contentFields) ||
    value["kind"] !== "adapter_acknowledgement" ||
    value["schemaVersion"] !== PROVIDER_ACKNOWLEDGEMENT_SCHEMA_VERSION ||
    !safeString(value["credentialId"]) ||
    !Number.isSafeInteger(value["issuedAt"]) ||
    !Number.isSafeInteger(value["expiresAt"]) ||
    !safeString(value["nonce"], 256) ||
    !safeString(value["requestNonce"], 256) ||
    typeof value["operation"] !== "string" ||
    !operationSet.has(value["operation"]) ||
    !safeString(value["connectionId"]) ||
    !safeString(value["tenantId"]) ||
    !safeString(value["environment"]) ||
    !safeString(value["idempotencyKey"]) ||
    typeof value["commandFingerprint"] !== "string" ||
    !fingerprintPattern.test(value["commandFingerprint"]) ||
    (value["disposition"] !== "completed" && value["disposition"] !== "pending")
  ) {
    return undefined;
  }
  const mappingVersion = canonicalizeMappingVersion(value["mappingVersion"]);
  const operation = value["operation"] as AdapterOperation;
  const result = validateResult(
    operation,
    value["disposition"],
    value["result"],
    expectedResourceId,
  );
  if (mappingVersion === undefined || result === undefined) {
    return undefined;
  }
  return Object.freeze({
    kind: "adapter_acknowledgement",
    schemaVersion: PROVIDER_ACKNOWLEDGEMENT_SCHEMA_VERSION,
    credentialId: value["credentialId"],
    issuedAt: value["issuedAt"] as number,
    expiresAt: value["expiresAt"] as number,
    nonce: value["nonce"],
    requestNonce: value["requestNonce"],
    operation,
    connectionId: value["connectionId"],
    tenantId: value["tenantId"],
    environment: value["environment"],
    commandFingerprint: value["commandFingerprint"],
    idempotencyKey: value["idempotencyKey"],
    mappingVersion,
    disposition: value["disposition"],
    result,
  });
}

function failure(
  code: string,
  message: string,
): AcknowledgementVerificationResult {
  return Object.freeze({ ok: false, code, message });
}

export function createAuthenticatedProviderAcknowledgement(
  input: Omit<
    ProviderAcknowledgementContent,
    | "credentialId"
    | "expiresAt"
    | "issuedAt"
    | "kind"
    | "nonce"
    | "schemaVersion"
  >,
  credential: ScopedCredential,
  options: CreateProviderAcknowledgementOptions = {},
): AuthenticatedProviderAcknowledgement {
  if (credential.role !== "response") {
    throw new RangeError("A response-role credential is required.");
  }
  const issuedAt = options.issuedAt ?? Date.now();
  const maximumLifetime = options.maximumLifetimeMilliseconds ?? 300_000;
  const expiresAt = options.expiresAt ?? issuedAt + 60_000;
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > maximumLifetime ||
    !safeString(nonce, 256)
  ) {
    throw new RangeError("The acknowledgement lifetime or nonce is invalid.");
  }
  const content = canonicalizeAcknowledgementContent({
    kind: "adapter_acknowledgement",
    schemaVersion: PROVIDER_ACKNOWLEDGEMENT_SCHEMA_VERSION,
    credentialId: credential.id,
    issuedAt,
    expiresAt,
    nonce,
    ...input,
  });
  if (content === undefined) {
    throw new TypeError("The acknowledgement content is invalid.");
  }
  return Object.freeze({
    ...content,
    signature: Object.freeze({
      algorithm: PROVIDER_ACKNOWLEDGEMENT_SIGNATURE_ALGORITHM,
      value: computeProviderAcknowledgementSignature(content, credential),
    }),
  });
}

function parseAcknowledgement(
  value: unknown,
  binding: AcknowledgementBinding,
): AuthenticatedProviderAcknowledgement | undefined {
  if (!exactKeys(value, envelopeFields)) {
    return undefined;
  }
  const content = canonicalizeAcknowledgementContent(
    Object.fromEntries(
      [...contentFields].map((field) => [field, value[field]]),
    ),
    binding.expectedResourceId,
  );
  if (
    content === undefined ||
    content.operation !== binding.operation ||
    content.connectionId !== binding.connectionId ||
    content.tenantId !== binding.tenantId ||
    content.environment !== binding.environment ||
    content.idempotencyKey !== binding.idempotencyKey ||
    content.commandFingerprint !== binding.commandFingerprint ||
    content.requestNonce !== binding.requestNonce ||
    !sameMappingVersion(content.mappingVersion, binding.mappingVersion) ||
    !exactKeys(value["signature"], new Set(["algorithm", "value"])) ||
    value["signature"]["algorithm"] !==
      PROVIDER_ACKNOWLEDGEMENT_SIGNATURE_ALGORITHM ||
    typeof value["signature"]["value"] !== "string" ||
    !signaturePattern.test(value["signature"]["value"])
  ) {
    return undefined;
  }
  return Object.freeze({
    ...content,
    signature: Object.freeze({
      algorithm: PROVIDER_ACKNOWLEDGEMENT_SIGNATURE_ALGORITHM,
      value: value["signature"]["value"],
    }),
  });
}

export async function verifyProviderAcknowledgement(
  value: unknown,
  binding: AcknowledgementBinding,
  credential: ScopedCredential,
  replayStore: AcknowledgementReplayStore,
  options: {
    readonly maximumClockSkewMilliseconds?: number;
    readonly maximumLifetimeMilliseconds?: number;
    readonly deadlineAt?: number;
    readonly now?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<AcknowledgementVerificationResult> {
  const acknowledgement = parseAcknowledgement(value, binding);
  if (acknowledgement === undefined) {
    return failure(
      "acknowledgement.invalid_or_unbound",
      "The provider acknowledgement is unsigned, malformed, contradictory, or not bound to the command.",
    );
  }
  if (
    credential.role !== "response" ||
    acknowledgement.credentialId !== credential.id
  ) {
    return failure(
      "acknowledgement.wrong_key",
      "The acknowledgement response key is not accepted.",
    );
  }
  const expectedSignature = Buffer.from(
    computeProviderAcknowledgementSignature(acknowledgement, credential),
    "base64url",
  );
  const actualSignature = Buffer.from(
    acknowledgement.signature.value,
    "base64url",
  );
  if (
    expectedSignature.byteLength !== actualSignature.byteLength ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return failure(
      "acknowledgement.signature_invalid",
      "The provider acknowledgement signature is invalid.",
    );
  }
  const now = options.now ?? Date.now();
  const skew = options.maximumClockSkewMilliseconds ?? 30_000;
  const maximumLifetime = options.maximumLifetimeMilliseconds ?? 300_000;
  if (
    acknowledgement.issuedAt > now + skew ||
    acknowledgement.expiresAt <= now ||
    acknowledgement.expiresAt <= acknowledgement.issuedAt ||
    acknowledgement.expiresAt - acknowledgement.issuedAt > maximumLifetime
  ) {
    return failure(
      "acknowledgement.expired",
      "The provider acknowledgement is expired.",
    );
  }
  const scope = checkCredentialScope(credential, {
    adapterId: binding.adapterId,
    connectionId: binding.connectionId,
    tenantId: binding.tenantId,
    environment: binding.environment,
    purpose: "acknowledgement.verify",
    role: "response",
    now,
  });
  if (!scope.ok) {
    return failure(
      `acknowledgement.${scope.reason ?? "scope_mismatch"}`,
      "The acknowledgement credential is outside its response scope.",
    );
  }
  let firstObservation: boolean;
  const replayDeadlineAt = Math.min(
    options.deadlineAt ?? acknowledgement.expiresAt,
    acknowledgement.expiresAt,
  );
  const replayDeadline = createDeadlineSignal(replayDeadlineAt, options.signal);
  try {
    if (replayDeadline.signal.aborted) {
      throw replayDeadline.signal.reason instanceof Error
        ? replayDeadline.signal.reason
        : new DOMException(
            "The acknowledgement replay deadline expired.",
            "AbortError",
          );
    }
    const consume = replayStore.consume({
      credentialId: acknowledgement.credentialId,
      nonce: acknowledgement.nonce,
      requestNonce: acknowledgement.requestNonce,
      commandFingerprint: acknowledgement.commandFingerprint,
      expiresAt: acknowledgement.expiresAt,
      deadlineAt: replayDeadlineAt,
      signal: replayDeadline.signal,
    });
    firstObservation = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (!settled) {
          settled = true;
          replayDeadline.signal.removeEventListener("abort", abort);
          callback();
        }
      };
      const abort = (): void => {
        finish(() =>
          reject(
            replayDeadline.signal.reason instanceof Error
              ? replayDeadline.signal.reason
              : new DOMException(
                  "The acknowledgement replay deadline expired.",
                  "AbortError",
                ),
          ),
        );
      };
      replayDeadline.signal.addEventListener("abort", abort, {
        once: true,
      });
      if (replayDeadline.signal.aborted) {
        abort();
        return;
      }
      void consume.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) =>
          finish(() =>
            reject(
              error instanceof Error
                ? error
                : new Error("The acknowledgement replay store failed."),
            ),
          ),
      );
    });
  } catch {
    return failure(
      "acknowledgement.replay_store_unavailable",
      "The acknowledgement replay store is unavailable.",
    );
  } finally {
    replayDeadline.dispose();
  }
  if (!firstObservation) {
    return failure(
      "acknowledgement.replayed",
      "The provider acknowledgement was already consumed.",
    );
  }
  return Object.freeze({ ok: true, acknowledgement });
}
