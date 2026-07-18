// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

import {
  assertWellFormedUnicode,
  createDeadlineSignal,
  validateIdempotencyKey,
  type AdapterCommandResult,
  type AdapterOperation,
} from "@webhook-portal/adapter-sdk";

export const DEFAULT_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS =
  86_400_000 as const;
export const MAX_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS =
  2_592_000_000 as const;
export const IDEMPOTENCY_HEADER_VERSION = "whp-idem-v1" as const;

export function deriveIdempotencyHeaderValue(key: string): string {
  if (!validateIdempotencyKey(key)) {
    throw new RangeError("The idempotency key is invalid.");
  }
  return `${IDEMPOTENCY_HEADER_VERSION}.${createHash("sha256")
    .update(key, "utf8")
    .digest("base64url")}`;
}

export async function withIdempotencyStoreDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineAt: number,
  parentSignal?: AbortSignal,
  now: () => number = Date.now,
): Promise<T> {
  const deadline = createDeadlineSignal(deadlineAt, parentSignal, now);
  try {
    if (deadline.signal.aborted) {
      throw deadline.signal.reason instanceof Error
        ? deadline.signal.reason
        : new DOMException(
            "The idempotency store deadline expired.",
            "AbortError",
          );
    }
    const pending = operation(deadline.signal);
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (!settled) {
          settled = true;
          deadline.signal.removeEventListener("abort", abort);
          callback();
        }
      };
      const abort = (): void => {
        finish(() =>
          reject(
            deadline.signal.reason instanceof Error
              ? deadline.signal.reason
              : new DOMException(
                  "The idempotency store deadline expired.",
                  "AbortError",
                ),
          ),
        );
      };
      deadline.signal.addEventListener("abort", abort, { once: true });
      if (deadline.signal.aborted) {
        abort();
        return;
      }
      void pending.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) =>
          finish(() =>
            reject(
              error instanceof Error
                ? error
                : new Error("The idempotency store operation failed."),
            ),
          ),
      );
    });
  } finally {
    deadline.dispose();
  }
}

export interface IdempotencyBeginInput {
  readonly commandDeadline: number;
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly idempotencyKey: string;
  readonly deadlineAt: number;
  /** Earliest time an abandoned in-progress lease may be reclaimed. */
  readonly leaseExpiresAt: number;
  readonly operation: AdapterOperation;
  /** Earliest time a completed result may be purged. */
  readonly resultExpiresAt: number;
  readonly safetyGraceMilliseconds: number;
  readonly signal: AbortSignal;
}

export interface IdempotencyLookupInput {
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly idempotencyKey: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export type IdempotencyLookupResult =
  | {
      readonly status: "miss";
    }
  | {
      readonly operation: AdapterOperation;
      readonly status: "conflict";
    }
  | {
      readonly status: "in_progress";
    }
  | {
      readonly result: AdapterCommandResult;
      readonly status: "replay";
    };

export type IdempotencyBeginResult =
  | {
      readonly leaseToken: string;
      readonly status: "acquired";
    }
  | {
      readonly operation: AdapterOperation;
      readonly status: "conflict";
    }
  | {
      readonly status: "in_progress";
    }
  | {
      readonly result: AdapterCommandResult;
      readonly status: "replay";
    }
  | {
      readonly status: "capacity";
    };

export interface IdempotencyCompleteInput {
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly idempotencyKey: string;
  readonly deadlineAt: number;
  readonly leaseToken: string;
  readonly result: AdapterCommandResult;
  readonly signal: AbortSignal;
}

export interface IdempotencyReleaseInput {
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly idempotencyKey: string;
  readonly deadlineAt: number;
  readonly leaseToken: string;
  readonly signal: AbortSignal;
}

/**
 * begin must be atomic across every process sharing a connection. Implementors
 * must not reclaim in-progress leases before leaseExpiresAt or completed
 * results before resultExpiresAt. complete/release must compare leaseToken.
 */
export interface IdempotencyStore {
  begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult>;
  complete(input: IdempotencyCompleteInput): Promise<void>;
  lookup(input: IdempotencyLookupInput): Promise<IdempotencyLookupResult>;
  release(input: IdempotencyReleaseInput): Promise<void>;
}

interface InMemoryIdempotencyRecord {
  readonly commandFingerprint: string;
  readonly leaseExpiresAt: number;
  readonly leaseToken: string;
  readonly operation: AdapterOperation;
  readonly result?: AdapterCommandResult;
  readonly resultExpiresAt: number;
  readonly state: "completed" | "in_progress";
}

export interface InMemoryIdempotencyStoreOptions {
  readonly clock?: () => number;
  readonly maxEntries?: number;
  readonly tokenFactory?: () => string;
}

export class IdempotencyLeaseError extends Error {
  readonly code = "idempotency_lease_mismatch";

  constructor() {
    super(
      "The idempotency lease is stale, expired, or owned by another caller.",
    );
    this.name = "IdempotencyLeaseError";
  }
}

function storageKey(connectionId: string, idempotencyKey: string): string {
  assertWellFormedUnicode(connectionId, "Idempotency connection ID");
  assertWellFormedUnicode(idempotencyKey, "Idempotency key");
  return `${connectionId.length}:${connectionId}${idempotencyKey.length}:${idempotencyKey}`;
}

function validateFingerprint(value: string): void {
  assertWellFormedUnicode(value, "Command fingerprint");
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError("The command fingerprint is invalid.");
  }
}

function validateExpiry(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be valid epoch milliseconds.`);
  }
}

function assertIoActive(
  input: { readonly deadlineAt: number; readonly signal: AbortSignal },
  now: number,
): void {
  validateExpiry("deadlineAt", input.deadlineAt);
  if (input.signal.aborted || input.deadlineAt <= now) {
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new DOMException("The store operation deadline expired.", "AbortError");
  }
}

function validateLeaseToken(value: string): void {
  assertWellFormedUnicode(value, "Idempotency lease token");
  if (
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError("The idempotency lease token is invalid.");
  }
}

/**
 * Reference/test implementation. Sharing one instance simulates a durable
 * store across adapter restarts; production deployments must inject a durable,
 * cross-process implementation.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #clock: () => number;
  readonly #maxEntries: number;
  readonly #records = new Map<string, InMemoryIdempotencyRecord>();
  readonly #tokenFactory: () => string;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#tokenFactory = options.tokenFactory ?? randomUUID;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer.");
    }
  }

  async begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult> {
    assertIoActive(input, this.#clock());
    validateFingerprint(input.commandFingerprint);
    validateExpiry("leaseExpiresAt", input.leaseExpiresAt);
    validateExpiry("resultExpiresAt", input.resultExpiresAt);
    validateExpiry("commandDeadline", input.commandDeadline);
    if (
      !Number.isSafeInteger(input.safetyGraceMilliseconds) ||
      input.safetyGraceMilliseconds <= 0
    ) {
      throw new RangeError(
        "safetyGraceMilliseconds must be a positive safe integer.",
      );
    }
    const minimumLeaseExpiry =
      input.commandDeadline + input.safetyGraceMilliseconds;
    if (
      !Number.isSafeInteger(minimumLeaseExpiry) ||
      input.leaseExpiresAt < minimumLeaseExpiry
    ) {
      throw new RangeError(
        "An in-progress lease cannot expire before the command deadline plus safety grace.",
      );
    }
    if (input.resultExpiresAt < input.leaseExpiresAt) {
      throw new RangeError(
        "A completed result cannot expire before its command lease.",
      );
    }
    if (
      input.resultExpiresAt - input.leaseExpiresAt >
      MAX_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS
    ) {
      throw new RangeError(
        "The idempotency result retention exceeds the supported cap.",
      );
    }
    this.purgeExpired();
    const key = storageKey(input.connectionId, input.idempotencyKey);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.commandFingerprint !== input.commandFingerprint) {
        return Object.freeze({
          status: "conflict",
          operation: existing.operation,
        });
      }
      return existing.state === "completed"
        ? Object.freeze({
            status: "replay",
            result: existing.result as AdapterCommandResult,
          })
        : Object.freeze({ status: "in_progress" });
    }
    if (this.#records.size >= this.#maxEntries) {
      return Object.freeze({ status: "capacity" });
    }
    const leaseToken = this.#tokenFactory();
    validateLeaseToken(leaseToken);
    this.#records.set(
      key,
      Object.freeze({
        state: "in_progress",
        commandFingerprint: input.commandFingerprint,
        operation: input.operation,
        leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
        resultExpiresAt: input.resultExpiresAt,
      }),
    );
    return Object.freeze({ status: "acquired", leaseToken });
  }

  async lookup(
    input: IdempotencyLookupInput,
  ): Promise<IdempotencyLookupResult> {
    assertIoActive(input, this.#clock());
    validateFingerprint(input.commandFingerprint);
    this.purgeExpired();
    const existing = this.#records.get(
      storageKey(input.connectionId, input.idempotencyKey),
    );
    if (existing === undefined) {
      return Object.freeze({ status: "miss" });
    }
    if (existing.commandFingerprint !== input.commandFingerprint) {
      return Object.freeze({
        status: "conflict",
        operation: existing.operation,
      });
    }
    return existing.state === "completed"
      ? Object.freeze({
          status: "replay",
          result: existing.result as AdapterCommandResult,
        })
      : Object.freeze({ status: "in_progress" });
  }

  async complete(input: IdempotencyCompleteInput): Promise<void> {
    assertIoActive(input, this.#clock());
    validateFingerprint(input.commandFingerprint);
    validateLeaseToken(input.leaseToken);
    this.purgeExpired();
    const key = storageKey(input.connectionId, input.idempotencyKey);
    const existing = this.#records.get(key);
    if (
      existing?.state !== "in_progress" ||
      existing.commandFingerprint !== input.commandFingerprint ||
      existing.leaseToken !== input.leaseToken
    ) {
      throw new IdempotencyLeaseError();
    }
    this.#records.set(
      key,
      Object.freeze({
        ...existing,
        state: "completed",
        result: input.result,
      }),
    );
  }

  async release(input: IdempotencyReleaseInput): Promise<void> {
    assertIoActive(input, this.#clock());
    validateFingerprint(input.commandFingerprint);
    validateLeaseToken(input.leaseToken);
    this.purgeExpired();
    const key = storageKey(input.connectionId, input.idempotencyKey);
    const existing = this.#records.get(key);
    if (
      existing?.state !== "in_progress" ||
      existing.commandFingerprint !== input.commandFingerprint ||
      existing.leaseToken !== input.leaseToken
    ) {
      throw new IdempotencyLeaseError();
    }
    this.#records.delete(key);
  }

  purgeExpired(now = this.#clock()): number {
    let removed = 0;
    for (const [key, record] of this.#records) {
      const expiresAt =
        record.state === "completed"
          ? record.resultExpiresAt
          : record.leaseExpiresAt;
      if (expiresAt <= now) {
        this.#records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#records.size;
  }
}
