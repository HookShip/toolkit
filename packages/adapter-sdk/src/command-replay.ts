// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

import type { AdapterOperation } from "./capabilities.js";
import type { AdapterCommandResult } from "./commands.js";

export interface CommandReplayConsumeInput {
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly credentialId: string;
  readonly deadlineAt: number;
  readonly environment: string;
  readonly idempotencyKey: string;
  readonly nonce: string;
  readonly operation: AdapterOperation;
  readonly retainUntil: number;
  readonly signal: AbortSignal;
  readonly tenantId: string;
}

export type CommandReplayConsumeResult =
  | {
      readonly leaseToken: string;
      readonly status: "acquired";
    }
  | {
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

export interface CommandReplayCompleteInput {
  readonly commandFingerprint: string;
  readonly connectionId: string;
  readonly credentialId: string;
  readonly deadlineAt: number;
  readonly environment: string;
  readonly idempotencyKey: string;
  readonly leaseToken: string;
  readonly result: AdapterCommandResult;
  readonly signal: AbortSignal;
  readonly tenantId: string;
}

export interface CommandEnvelopeReplayStore {
  complete(input: CommandReplayCompleteInput): Promise<void>;
  consume(
    input: CommandReplayConsumeInput,
  ): Promise<CommandReplayConsumeResult>;
}

interface ReplayRecord {
  readonly commandFingerprint: string;
  readonly identityKey: string;
  readonly leaseToken: string;
  readonly nonce: string;
  readonly retainUntil: number;
  readonly result?: AdapterCommandResult;
  readonly state: "completed" | "in_progress";
}

export interface InMemoryCommandEnvelopeReplayStoreOptions {
  readonly clock?: () => number;
  readonly maxEntries?: number;
  readonly tokenFactory?: () => string;
}

export class CommandReplayLeaseError extends Error {
  readonly code = "command_replay_lease_mismatch";

  constructor() {
    super("The command replay lease is stale or owned by another verifier.");
    this.name = "CommandReplayLeaseError";
  }
}

export function commandReplayIdentityStorageKey(
  input: Pick<
    CommandReplayConsumeInput,
    | "connectionId"
    | "credentialId"
    | "environment"
    | "idempotencyKey"
    | "tenantId"
  >,
): string {
  return `whp_command_replay_${createHash("sha256")
    .update(
      JSON.stringify([
        input.credentialId,
        input.tenantId,
        input.environment,
        input.connectionId,
        input.idempotencyKey,
      ]),
      "utf8",
    )
    .digest("hex")}`;
}

export function commandReplayNonceStorageKey(
  credentialId: string,
  nonce: string,
): string {
  return `whp_command_nonce_${createHash("sha256")
    .update(JSON.stringify([credentialId, nonce]), "utf8")
    .digest("hex")}`;
}

function assertActive(
  input: { readonly deadlineAt: number; readonly signal: AbortSignal },
  now: number,
): void {
  if (
    input.signal.aborted ||
    !Number.isSafeInteger(input.deadlineAt) ||
    input.deadlineAt <= now
  ) {
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new DOMException("The command replay deadline expired.", "AbortError");
  }
}

export class InMemoryCommandEnvelopeReplayStore implements CommandEnvelopeReplayStore {
  readonly #clock: () => number;
  readonly #maxEntries: number;
  readonly #nonces = new Map<string, string>();
  readonly #records = new Map<string, ReplayRecord>();
  readonly #tokenFactory: () => string;

  constructor(options: InMemoryCommandEnvelopeReplayStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#tokenFactory = options.tokenFactory ?? randomUUID;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer.");
    }
  }

  async consume(
    input: CommandReplayConsumeInput,
  ): Promise<CommandReplayConsumeResult> {
    const now = this.#clock();
    assertActive(input, now);
    if (
      !Number.isSafeInteger(input.retainUntil) ||
      input.retainUntil <= now ||
      input.retainUntil < input.deadlineAt
    ) {
      throw new RangeError(
        "Replay retention cannot expire before the verification deadline.",
      );
    }
    this.purgeExpired(now);
    const key = commandReplayIdentityStorageKey(input);
    const nonce = commandReplayNonceStorageKey(input.credentialId, input.nonce);
    const nonceOwner = this.#nonces.get(nonce);
    if (nonceOwner !== undefined && nonceOwner !== key) {
      return Object.freeze({ status: "conflict" });
    }
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.commandFingerprint !== input.commandFingerprint) {
        return Object.freeze({ status: "conflict" });
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
    const record = Object.freeze({
      state: "in_progress" as const,
      identityKey: key,
      commandFingerprint: input.commandFingerprint,
      nonce: input.nonce,
      leaseToken,
      retainUntil: input.retainUntil,
    });
    this.#records.set(key, record);
    this.#nonces.set(nonce, key);
    return Object.freeze({ status: "acquired", leaseToken });
  }

  async complete(input: CommandReplayCompleteInput): Promise<void> {
    const now = this.#clock();
    assertActive(input, now);
    this.purgeExpired(now);
    const key = commandReplayIdentityStorageKey(input);
    const existing = this.#records.get(key);
    if (
      existing?.state !== "in_progress" ||
      existing.commandFingerprint !== input.commandFingerprint ||
      existing.leaseToken !== input.leaseToken
    ) {
      throw new CommandReplayLeaseError();
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

  purgeExpired(now = this.#clock()): number {
    let removed = 0;
    for (const [key, record] of this.#records) {
      if (record.retainUntil <= now) {
        this.#records.delete(key);
        for (const [nonce, owner] of this.#nonces) {
          if (owner === key) {
            this.#nonces.delete(nonce);
          }
        }
        removed += 1;
      }
    }
    return removed;
  }
}
