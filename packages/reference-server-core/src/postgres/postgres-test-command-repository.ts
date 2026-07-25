// SPDX-License-Identifier: Apache-2.0

import {
  PostgresRepositoryContext,
  selectRecord,
  sameJson,
  type JsonRecordRow,
} from "./postgres-repository-context.js";
import type {
  TestCommandRepository,
  BeginTestCommandResult,
  CreateTestCommandInput,
  TestCommandRecord,
  TestCommandResult,
} from "../types.js";

export class PostgresTestCommandRepository implements TestCommandRepository {
  readonly #ctx: PostgresRepositoryContext;

  constructor(ctx: PostgresRepositoryContext) {
    this.#ctx = ctx;
  }

  async beginTestCommand(
    input: CreateTestCommandInput,
  ): Promise<BeginTestCommandResult> {
    const command: TestCommandRecord = {
      id: input.id,
      endpointId: input.endpointId,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      state: "requested",
      evidenceState: "pending",
      context: input.context,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
    const inserted = await this.#ctx.client().query<JsonRecordRow>(
      `INSERT INTO reference_test_commands(
           id, endpoint_id, idempotency_key, request_fingerprint, state,
           created_at, updated_at, record
         )
         VALUES ($1, $2, $3, $4, 'requested', $5, $5, $6::jsonb)
         ON CONFLICT(endpoint_id, idempotency_key) DO NOTHING
         RETURNING record`,
      [
        command.id,
        command.endpointId,
        command.idempotencyKey,
        command.requestFingerprint,
        command.createdAt,
        JSON.stringify(command),
      ],
    );
    if (inserted.rowCount !== 0) {
      return { status: "created", command };
    }
    const existing = await this.getTestCommandByIdempotency(
      input.endpointId,
      input.idempotencyKey,
    );
    if (existing === undefined) {
      throw new Error("Unable to resolve idempotent command.");
    }
    return {
      status:
        existing.requestFingerprint === input.requestFingerprint
          ? "existing"
          : "conflict",
      command: existing,
    };
  }

  async getTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return selectRecord<TestCommandRecord>(
      this.#ctx.client(),
      "SELECT record FROM reference_test_commands WHERE id = $1",
      [id],
    );
  }

  async getTestCommandByIdempotency(
    endpointId: string,
    idempotencyKey: string,
  ): Promise<TestCommandRecord | undefined> {
    return selectRecord<TestCommandRecord>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_test_commands
         WHERE endpoint_id = $1 AND idempotency_key = $2`,
      [endpointId, idempotencyKey],
    );
  }

  async lockTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return selectRecord<TestCommandRecord>(
      this.#ctx.client(),
      "SELECT record FROM reference_test_commands WHERE id = $1 FOR UPDATE",
      [id],
    );
  }

  async markTestCommandDispatched(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#ctx.repository.transaction(async () => {
      const current = await this.lockTestCommand(id);
      if (current === undefined) {
        return undefined;
      }
      if (
        current.state !== "requested" ||
        current.pendingResult !== undefined
      ) {
        return current;
      }
      const next: TestCommandRecord = {
        ...current,
        state: "dispatched",
        dispatchedAt: timestamp,
        updatedAt: timestamp,
      };
      await this.#ctx.client().query(
        `UPDATE reference_test_commands
           SET state = 'dispatched', updated_at = $2, record = $3::jsonb
           WHERE id = $1`,
        [id, timestamp, JSON.stringify(next)],
      );
      return next;
    });
  }

  async stageTestCommandResult(
    id: string,
    timestamp: string,
    result: TestCommandResult,
  ): Promise<TestCommandRecord | undefined> {
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.repository.acquireTimelineEvidenceLocks({
        commandIds: [id],
      });
      const current = await this.lockTestCommand(id);
      if (current === undefined || current.evidenceState === "complete") {
        return current;
      }
      if (
        current.pendingResult !== undefined &&
        !sameJson(current.pendingResult, result)
      ) {
        throw new Error("A staged test result cannot be overwritten.");
      }
      const next: TestCommandRecord = {
        ...current,
        evidenceState: "pending",
        pendingResult: current.pendingResult ?? result,
        resultObservedAt: current.resultObservedAt ?? timestamp,
        updatedAt: timestamp,
      };
      await this.#ctx.client().query(
        `UPDATE reference_test_commands
           SET updated_at = $2, record = $3::jsonb
           WHERE id = $1`,
        [id, timestamp, JSON.stringify(next)],
      );
      return next;
    });
  }

  async completeTestCommand(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.repository.acquireTimelineEvidenceLocks({
        commandIds: [id],
      });
      const current = await this.lockTestCommand(id);
      if (current === undefined || current.evidenceState === "complete") {
        return current;
      }
      if (current.pendingResult === undefined) {
        throw new Error(
          "A test command cannot complete without a staged result.",
        );
      }
      const { pendingResult, ...withoutPending } = current;
      const next: TestCommandRecord = {
        ...withoutPending,
        state: pendingResult.state,
        evidenceState: "complete",
        result: pendingResult,
        updatedAt: timestamp,
      };
      await this.#ctx.client().query(
        `UPDATE reference_test_commands
           SET state = $2, updated_at = $3, record = $4::jsonb
           WHERE id = $1`,
        [id, next.state, timestamp, JSON.stringify(next)],
      );
      return next;
    });
  }
}
