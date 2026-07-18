// SPDX-License-Identifier: Apache-2.0

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  ADAPTER_OPERATIONS,
  isSideEffectingOperation,
  type AdapterOperation,
} from "./capabilities.js";
import {
  assertWellFormedUnicode,
  compareUtf16CodeUnits,
  isWellFormedUnicode,
} from "./canonical.js";
import type { AdapterCommand, AdapterCommandResult } from "./commands.js";
import type {
  CommandEnvelopeReplayStore,
  CommandReplayCompleteInput,
} from "./command-replay.js";
import {
  checkCredentialScope,
  validateIdempotencyKey,
  type ActorContext,
  type ScopedCredential,
} from "./context.js";
import type { AdapterJsonValue } from "./model.js";
import { isSecretValue, revealSecret } from "./secret.js";
import { withDeadline } from "./deadline.js";

export const COMMAND_ENVELOPE_SCHEMA_VERSION = "2026-07-01" as const;
export const COMMAND_ENVELOPE_SIGNATURE_ALGORITHM = "hmac-sha256" as const;
export const DEFAULT_COMMAND_REPLAY_RETENTION_MILLISECONDS =
  86_400_000 as const;
export const MAX_COMMAND_REPLAY_RETENTION_MILLISECONDS = 2_592_000_000 as const;

export interface CanonicalCommandPayload {
  readonly input: AdapterJsonValue;
  readonly kind: AdapterOperation;
}

export interface CommandEnvelopeContent {
  readonly actor: ActorContext;
  readonly command: CanonicalCommandPayload;
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly credentialId: string;
  readonly deadlineAt: number;
  readonly environment: string;
  readonly idempotencyKey: string;
  readonly issuedAt: number;
  readonly kind: "adapter_command";
  readonly nonce: string;
  readonly operation: AdapterOperation;
  readonly schemaVersion: typeof COMMAND_ENVELOPE_SCHEMA_VERSION;
  readonly tenantId: string;
}

export interface AuthenticatedCommandEnvelope extends CommandEnvelopeContent {
  readonly signature: {
    readonly algorithm: typeof COMMAND_ENVELOPE_SIGNATURE_ALGORITHM;
    readonly value: string;
  };
}

export interface CreateCommandEnvelopeOptions {
  readonly issuedAt?: number;
  readonly maximumLifetimeMilliseconds?: number;
  readonly nonce?: string;
}

export interface VerifyCommandEnvelopeExpected {
  readonly actor?: ActorContext;
  readonly adapterId: string;
  readonly connectionId: string;
  readonly environment: string;
  readonly host?: string;
  readonly operation?: AdapterOperation;
  readonly tenantId: string;
}

export interface VerifyCommandEnvelopeOptions {
  readonly maximumClockSkewMilliseconds?: number;
  readonly maximumLifetimeMilliseconds?: number;
  readonly now?: number;
}

export interface VerifyCommandEnvelopeReplayOptions extends VerifyCommandEnvelopeOptions {
  readonly replayRetentionMilliseconds?: number;
  readonly signal?: AbortSignal;
  readonly storeDeadlineAt?: number;
}

export type CommandEnvelopeVerificationResult =
  | {
      readonly envelope: AuthenticatedCommandEnvelope;
      readonly ok: true;
    }
  | {
      readonly code: string;
      readonly message: string;
      readonly ok: false;
    };

export type ReplayProtectedCommandEnvelopeVerificationResult =
  | {
      readonly envelope: AuthenticatedCommandEnvelope;
      readonly lease: Omit<
        CommandReplayCompleteInput,
        "deadlineAt" | "result" | "signal"
      >;
      readonly ok: true;
      readonly status: "accepted";
    }
  | {
      readonly envelope: AuthenticatedCommandEnvelope;
      readonly ok: true;
      readonly result: AdapterCommandResult;
      readonly status: "replay";
    }
  | {
      readonly envelope: AuthenticatedCommandEnvelope;
      readonly ok: true;
      readonly status: "verified";
    }
  | {
      readonly code: string;
      readonly message: string;
      readonly ok: false;
    };

const operationSet = new Set<string>(ADAPTER_OPERATIONS);
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const safeStringPattern = /^[^\u0000-\u001f\u007f]+$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const signaturePattern = /^[A-Za-z0-9_-]{43}$/u;

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function safeString(value: unknown, maximum = 2_048): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    isWellFormedUnicode(value) &&
    safeStringPattern.test(value)
  );
}

function canonicalize(
  value: unknown,
  revealSecrets: boolean,
): AdapterJsonValue {
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number): AdapterJsonValue => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) {
      throw new RangeError("Canonical command data exceeds its limits.");
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string"
    ) {
      if (typeof candidate === "string") {
        assertWellFormedUnicode(candidate);
      }
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new TypeError(
          "Canonical command data contains an invalid number.",
        );
      }
      return candidate;
    }
    if (isSecretValue(candidate)) {
      if (!revealSecrets) {
        throw new TypeError(
          "A secret cannot be canonicalized in this context.",
        );
      }
      const revealed = revealSecret(candidate);
      assertWellFormedUnicode(revealed, "Secret command value");
      return revealed;
    }
    if (typeof candidate !== "object") {
      throw new TypeError("Canonical command data must be JSON-compatible.");
    }
    if (seen.has(candidate)) {
      throw new TypeError("Canonical command data must not contain cycles.");
    }
    seen.add(candidate);

    let result: AdapterJsonValue;
    if (Array.isArray(candidate)) {
      result = candidate.map((item) => visit(item, depth + 1));
    } else {
      if (!isPlainObject(candidate)) {
        throw new TypeError(
          "Canonical command data must contain only plain objects.",
        );
      }
      const entries: [string, AdapterJsonValue][] = [];
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(candidate),
      )) {
        assertWellFormedUnicode(key, "Canonical object key");
        if (
          descriptor.enumerable !== true ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          unsafeKeys.has(key)
        ) {
          throw new TypeError(
            "Canonical command data contains an unsafe property.",
          );
        }
        if (descriptor.value !== undefined) {
          entries.push([key, visit(descriptor.value, depth + 1)]);
        }
      }
      result = Object.fromEntries(
        entries.sort(([left], [right]) => compareUtf16CodeUnits(left, right)),
      );
    }
    seen.delete(candidate);
    return result;
  };

  return visit(value, 0);
}

function canonicalStringify(value: AdapterJsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalStringify(item as AdapterJsonValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function envelopeFingerprintMaterial(
  input: Pick<
    CommandEnvelopeContent,
    | "actor"
    | "command"
    | "connectionId"
    | "environment"
    | "operation"
    | "tenantId"
  >,
): AdapterJsonValue {
  return canonicalize(
    {
      operation: input.operation,
      command: input.command,
      tenantId: input.tenantId,
      environment: input.environment,
      actor: input.actor,
      connectionId: input.connectionId,
    },
    true,
  );
}

export function computeCommandFingerprint(
  input: Pick<
    CommandEnvelopeContent,
    | "actor"
    | "command"
    | "connectionId"
    | "environment"
    | "operation"
    | "tenantId"
  >,
): string {
  return createHash("sha256")
    .update(canonicalStringify(envelopeFingerprintMaterial(input)), "utf8")
    .digest("hex");
}

export function computeAdapterCommandFingerprint(
  command: AdapterCommand,
): string {
  return computeCommandFingerprint({
    operation: command.kind,
    command: {
      kind: command.kind,
      input: canonicalize(command.input, true),
    },
    tenantId: command.context.tenant.id,
    environment: command.context.environment.id,
    actor: command.context.actor,
    connectionId: command.context.connection.id,
  });
}

function signingContent(content: CommandEnvelopeContent): AdapterJsonValue {
  return canonicalize(
    {
      kind: content.kind,
      schemaVersion: content.schemaVersion,
      operation: content.operation,
      command: content.command,
      tenantId: content.tenantId,
      environment: content.environment,
      actor: content.actor,
      connectionId: content.connectionId,
      deadlineAt: content.deadlineAt,
      issuedAt: content.issuedAt,
      nonce: content.nonce,
      idempotencyKey: content.idempotencyKey,
      commandFingerprint: content.commandFingerprint,
      credentialId: content.credentialId,
    },
    true,
  );
}

export function computeCommandEnvelopeSignature(
  content: CommandEnvelopeContent,
  credential: ScopedCredential,
): string {
  return createHmac("sha256", revealSecret(credential.secret))
    .update(canonicalStringify(signingContent(content)), "utf8")
    .digest("base64url");
}

function freezeEnvelope(
  envelope: AuthenticatedCommandEnvelope,
): AuthenticatedCommandEnvelope {
  return Object.freeze({
    ...envelope,
    actor: Object.freeze({ ...envelope.actor }),
    command: Object.freeze({
      ...envelope.command,
      input: envelope.command.input,
    }),
    signature: Object.freeze({ ...envelope.signature }),
  });
}

export function createAuthenticatedCommandEnvelope(
  command: AdapterCommand,
  credential: ScopedCredential,
  options: CreateCommandEnvelopeOptions = {},
): AuthenticatedCommandEnvelope {
  if (
    command.context.credential !== undefined &&
    command.context.credential.id !== credential.id
  ) {
    throw new RangeError(
      "The command credential does not match the signing credential.",
    );
  }
  if (!validateIdempotencyKey(command.context.idempotency.key)) {
    throw new RangeError("The command idempotency key is invalid.");
  }
  const issuedAt = options.issuedAt ?? Date.now();
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  const maximumLifetime = options.maximumLifetimeMilliseconds ?? 300_000;
  if (
    !Number.isSafeInteger(issuedAt) ||
    !safeString(nonce, 256) ||
    command.context.deadline.at <= issuedAt ||
    command.context.deadline.at - issuedAt > maximumLifetime
  ) {
    throw new RangeError("The command envelope lifetime is invalid.");
  }
  const payload = Object.freeze({
    kind: command.kind,
    input: canonicalize(command.input, true),
  }) satisfies CanonicalCommandPayload;
  const fingerprintInput = {
    operation: command.kind,
    command: payload,
    tenantId: command.context.tenant.id,
    environment: command.context.environment.id,
    actor: command.context.actor,
    connectionId: command.context.connection.id,
  } as const;
  const content: CommandEnvelopeContent = {
    kind: "adapter_command",
    schemaVersion: COMMAND_ENVELOPE_SCHEMA_VERSION,
    operation: command.kind,
    command: payload,
    tenantId: command.context.tenant.id,
    environment: command.context.environment.id,
    actor: Object.freeze({ ...command.context.actor }),
    connectionId: command.context.connection.id,
    deadlineAt: command.context.deadline.at,
    issuedAt,
    nonce,
    idempotencyKey: command.context.idempotency.key,
    commandFingerprint: computeCommandFingerprint(fingerprintInput),
    credentialId: credential.id,
  };
  return freezeEnvelope({
    ...content,
    signature: {
      algorithm: COMMAND_ENVELOPE_SIGNATURE_ALGORITHM,
      value: computeCommandEnvelopeSignature(content, credential),
    },
  });
}

function parseEnvelope(
  value: unknown,
): AuthenticatedCommandEnvelope | undefined {
  if (
    !isPlainObject(value) ||
    !exactKeys(value, [
      "actor",
      "command",
      "commandFingerprint",
      "connectionId",
      "credentialId",
      "deadlineAt",
      "environment",
      "idempotencyKey",
      "issuedAt",
      "kind",
      "nonce",
      "operation",
      "schemaVersion",
      "signature",
      "tenantId",
    ]) ||
    value["kind"] !== "adapter_command" ||
    value["schemaVersion"] !== COMMAND_ENVELOPE_SCHEMA_VERSION ||
    typeof value["operation"] !== "string" ||
    !operationSet.has(value["operation"]) ||
    !safeString(value["tenantId"]) ||
    !safeString(value["environment"]) ||
    !safeString(value["connectionId"]) ||
    !safeString(value["credentialId"]) ||
    typeof value["idempotencyKey"] !== "string" ||
    !validateIdempotencyKey(value["idempotencyKey"]) ||
    !Number.isSafeInteger(value["deadlineAt"]) ||
    !Number.isSafeInteger(value["issuedAt"]) ||
    !safeString(value["nonce"], 256) ||
    typeof value["commandFingerprint"] !== "string" ||
    !fingerprintPattern.test(value["commandFingerprint"]) ||
    !isPlainObject(value["actor"]) ||
    !exactKeys(value["actor"], ["id", "type"]) ||
    !safeString(value["actor"]["id"]) ||
    (value["actor"]["type"] !== "human" &&
      value["actor"]["type"] !== "service" &&
      value["actor"]["type"] !== "system") ||
    !isPlainObject(value["command"]) ||
    !exactKeys(value["command"], ["input", "kind"]) ||
    value["command"]["kind"] !== value["operation"] ||
    !isPlainObject(value["signature"]) ||
    !exactKeys(value["signature"], ["algorithm", "value"]) ||
    value["signature"]["algorithm"] !== COMMAND_ENVELOPE_SIGNATURE_ALGORITHM ||
    typeof value["signature"]["value"] !== "string" ||
    !signaturePattern.test(value["signature"]["value"])
  ) {
    return undefined;
  }

  let input: AdapterJsonValue;
  try {
    input = canonicalize(value["command"]["input"], false);
  } catch {
    return undefined;
  }
  return freezeEnvelope({
    kind: "adapter_command",
    schemaVersion: COMMAND_ENVELOPE_SCHEMA_VERSION,
    operation: value["operation"] as AdapterOperation,
    command: {
      kind: value["operation"] as AdapterOperation,
      input,
    },
    tenantId: value["tenantId"],
    environment: value["environment"],
    actor: value["actor"] as unknown as ActorContext,
    connectionId: value["connectionId"],
    deadlineAt: value["deadlineAt"] as number,
    issuedAt: value["issuedAt"] as number,
    nonce: value["nonce"],
    idempotencyKey: value["idempotencyKey"],
    commandFingerprint: value["commandFingerprint"],
    credentialId: value["credentialId"],
    signature: {
      algorithm: COMMAND_ENVELOPE_SIGNATURE_ALGORITHM,
      value: value["signature"]["value"],
    },
  });
}

function failure(
  code: string,
  message: string,
): Extract<CommandEnvelopeVerificationResult, { readonly ok: false }> {
  return Object.freeze({ ok: false, code, message });
}

function verifyEnvelopeCore(
  value: unknown,
  credential: ScopedCredential,
  expected: VerifyCommandEnvelopeExpected,
  options: VerifyCommandEnvelopeOptions = {},
): CommandEnvelopeVerificationResult {
  const envelope = parseEnvelope(value);
  if (envelope === undefined) {
    return failure("envelope.invalid", "The command envelope is invalid.");
  }
  const fingerprint = computeCommandFingerprint(envelope);
  if (fingerprint !== envelope.commandFingerprint) {
    return failure(
      "envelope.fingerprint_mismatch",
      "The command fingerprint does not match the signed payload.",
    );
  }
  if (envelope.credentialId !== credential.id) {
    return failure(
      "envelope.credential_mismatch",
      "The command envelope credential is not accepted.",
    );
  }
  const expectedSignature = Buffer.from(
    computeCommandEnvelopeSignature(envelope, credential),
    "base64url",
  );
  const actualSignature = Buffer.from(envelope.signature.value, "base64url");
  if (
    expectedSignature.byteLength !== actualSignature.byteLength ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return failure(
      "envelope.signature_invalid",
      "The command envelope signature is invalid.",
    );
  }

  const now = options.now ?? Date.now();
  const clockSkew = options.maximumClockSkewMilliseconds ?? 30_000;
  const maximumLifetime = options.maximumLifetimeMilliseconds ?? 300_000;
  if (
    envelope.issuedAt > now + clockSkew ||
    envelope.deadlineAt <= now ||
    envelope.deadlineAt <= envelope.issuedAt ||
    envelope.deadlineAt - envelope.issuedAt > maximumLifetime
  ) {
    return failure(
      "envelope.expired",
      "The command envelope is expired or outside its allowed lifetime.",
    );
  }
  if (envelope.tenantId !== expected.tenantId) {
    return failure("envelope.wrong_tenant", "The command tenant is invalid.");
  }
  if (envelope.environment !== expected.environment) {
    return failure(
      "envelope.wrong_environment",
      "The command environment is invalid.",
    );
  }
  if (envelope.connectionId !== expected.connectionId) {
    return failure(
      "envelope.wrong_connection",
      "The command connection is invalid.",
    );
  }
  if (
    expected.operation !== undefined &&
    envelope.operation !== expected.operation
  ) {
    return failure(
      "envelope.wrong_operation",
      "The command operation is invalid.",
    );
  }
  if (
    expected.actor !== undefined &&
    (envelope.actor.id !== expected.actor.id ||
      envelope.actor.type !== expected.actor.type)
  ) {
    return failure("envelope.wrong_actor", "The command actor is invalid.");
  }
  const scope = checkCredentialScope(credential, {
    adapterId: expected.adapterId,
    connectionId: expected.connectionId,
    environment: expected.environment,
    purpose: envelope.operation,
    role: "command",
    tenantId: expected.tenantId,
    ...(expected.host === undefined ? {} : { host: expected.host }),
    now,
  });
  if (!scope.ok) {
    return failure(
      `envelope.${scope.reason ?? "credential_scope_mismatch"}`,
      "The command credential is outside its authorized scope.",
    );
  }
  return Object.freeze({ ok: true, envelope });
}

export function verifyAuthenticatedCommandEnvelope(
  value: unknown,
  credential: ScopedCredential,
  expected: VerifyCommandEnvelopeExpected,
  options: VerifyCommandEnvelopeOptions = {},
): CommandEnvelopeVerificationResult {
  const verified = verifyEnvelopeCore(value, credential, expected, options);
  if (verified.ok && isSideEffectingOperation(verified.envelope.operation)) {
    return failure(
      "envelope.replay_protection_required",
      "Side-effecting command verification requires an atomic replay store.",
    );
  }
  return verified;
}

export async function verifyAuthenticatedCommandEnvelopeWithReplay(
  value: unknown,
  credential: ScopedCredential,
  expected: VerifyCommandEnvelopeExpected,
  replayStore: CommandEnvelopeReplayStore,
  options: VerifyCommandEnvelopeReplayOptions = {},
): Promise<ReplayProtectedCommandEnvelopeVerificationResult> {
  const verified = verifyEnvelopeCore(value, credential, expected, options);
  if (!verified.ok) {
    return verified;
  }
  const { envelope } = verified;
  if (!isSideEffectingOperation(envelope.operation)) {
    return Object.freeze({
      ok: true,
      status: "verified",
      envelope,
    });
  }
  const storeDeadlineAt = Math.min(
    options.storeDeadlineAt ?? envelope.deadlineAt,
    envelope.deadlineAt,
  );
  const replayRetention =
    options.replayRetentionMilliseconds ??
    DEFAULT_COMMAND_REPLAY_RETENTION_MILLISECONDS;
  const verifiedAt = options.now ?? Date.now();
  if (
    !Number.isSafeInteger(replayRetention) ||
    replayRetention <= 0 ||
    replayRetention > MAX_COMMAND_REPLAY_RETENTION_MILLISECONDS
  ) {
    return failure(
      "envelope.replay_retention_invalid",
      "Replay retention must be positive and within the supported cap.",
    );
  }
  const replayRetainUntil = Math.max(
    envelope.deadlineAt,
    verifiedAt + replayRetention,
  );
  if (
    !Number.isSafeInteger(replayRetainUntil) ||
    replayRetainUntil - verifiedAt > MAX_COMMAND_REPLAY_RETENTION_MILLISECONDS
  ) {
    return failure(
      "envelope.replay_retention_invalid",
      "Replay retention exceeds the supported absolute cap.",
    );
  }
  try {
    const decision = await withDeadline(
      storeDeadlineAt,
      (signal) =>
        replayStore.consume({
          credentialId: envelope.credentialId,
          tenantId: envelope.tenantId,
          environment: envelope.environment,
          connectionId: envelope.connectionId,
          idempotencyKey: envelope.idempotencyKey,
          commandFingerprint: envelope.commandFingerprint,
          nonce: envelope.nonce,
          operation: envelope.operation,
          retainUntil: replayRetainUntil,
          deadlineAt: storeDeadlineAt,
          signal,
        }),
      options.signal,
    );
    if (decision.status === "replay") {
      return Object.freeze({
        ok: true,
        status: "replay",
        envelope,
        result: decision.result,
      });
    }
    if (decision.status === "conflict") {
      return failure(
        "envelope.replay_conflict",
        "The idempotency identity is bound to a different command or nonce.",
      );
    }
    if (decision.status === "in_progress") {
      return failure(
        "envelope.replay_in_progress",
        "An identical command envelope is already being processed.",
      );
    }
    if (decision.status === "capacity") {
      return failure(
        "envelope.replay_store_capacity",
        "The command replay store cannot safely accept another identity.",
      );
    }
    return Object.freeze({
      ok: true,
      status: "accepted",
      envelope,
      lease: Object.freeze({
        credentialId: envelope.credentialId,
        tenantId: envelope.tenantId,
        environment: envelope.environment,
        connectionId: envelope.connectionId,
        idempotencyKey: envelope.idempotencyKey,
        commandFingerprint: envelope.commandFingerprint,
        leaseToken: decision.leaseToken,
      }),
    });
  } catch {
    return failure(
      "envelope.replay_store_unavailable",
      "The command replay store is unavailable or exceeded its deadline.",
    );
  }
}

export async function completeCommandEnvelopeReplay(
  replayStore: CommandEnvelopeReplayStore,
  accepted: Extract<
    ReplayProtectedCommandEnvelopeVerificationResult,
    { readonly status: "accepted" }
  >,
  result: AdapterCommandResult,
  options: {
    readonly deadlineAt?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  const deadlineAt = options.deadlineAt ?? accepted.envelope.deadlineAt;
  await withDeadline(
    deadlineAt,
    (signal) =>
      replayStore.complete({
        ...accepted.lease,
        result,
        deadlineAt,
        signal,
      }),
    options.signal,
  );
}
