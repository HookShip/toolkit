// SPDX-License-Identifier: Apache-2.0

import {
  InMemoryRepositoryState,
  commandKey,
  copy,
  sameJson,
} from "./memory-repository-state.js";
import type {
  TestCommandRepository,
  BeginTestCommandResult,
  CreateTestCommandInput,
  TestCommandRecord,
  TestCommandResult,
} from "../types.js";

export class InMemoryTestCommandRepository implements TestCommandRepository {
  readonly #ctx: InMemoryRepositoryState;

  constructor(ctx: InMemoryRepositoryState) {
    this.#ctx = ctx;
  }

  async beginTestCommand(
    input: CreateTestCommandInput,
  ): Promise<BeginTestCommandResult> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("beginTestCommand");
      const compound = commandKey(input.endpointId, input.idempotencyKey);
      const existingId = state.commandKeys.get(compound);
      if (existingId !== undefined) {
        const existing = state.commands.get(existingId);
        if (existing === undefined) {
          throw new Error("Command index is inconsistent.");
        }
        return {
          status:
            existing.requestFingerprint === input.requestFingerprint
              ? "existing"
              : "conflict",
          command: copy(existing),
        };
      }
      const command: TestCommandRecord = {
        id: input.id,
        endpointId: input.endpointId,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        state: "requested",
        evidenceState: "pending",
        context: copy(input.context),
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      };
      state.commands.set(command.id, command);
      state.commandKeys.set(compound, command.id);
      return { status: "created", command: copy(command) };
    });
  }

  async getTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.commands.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async getTestCommandByIdempotency(
    endpointId: string,
    idempotencyKey: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      const id = state.commandKeys.get(commandKey(endpointId, idempotencyKey));
      const value = id === undefined ? undefined : state.commands.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async lockTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return this.getTestCommand(id);
  }

  async markTestCommandDispatched(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("markTestCommandDispatched");
      const current = state.commands.get(id);
      if (current === undefined) {
        return undefined;
      }
      if (
        current.state !== "requested" ||
        current.pendingResult !== undefined
      ) {
        return copy(current);
      }
      const next: TestCommandRecord = {
        ...current,
        state: "dispatched",
        dispatchedAt: timestamp,
        updatedAt: timestamp,
      };
      state.commands.set(id, next);
      return copy(next);
    });
  }

  async stageTestCommandResult(
    id: string,
    timestamp: string,
    result: TestCommandResult,
  ): Promise<TestCommandRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("stageTestCommandResult");
      const current = state.commands.get(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.evidenceState === "complete") {
        return copy(current);
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
        pendingResult: copy(current.pendingResult ?? result),
        resultObservedAt: current.resultObservedAt ?? timestamp,
        updatedAt: timestamp,
      };
      state.commands.set(id, next);
      return copy(next);
    });
  }

  async completeTestCommand(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("completeTestCommand");
      const current = state.commands.get(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.evidenceState === "complete") {
        return copy(current);
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
        result: copy(pendingResult),
        updatedAt: timestamp,
      };
      state.commands.set(id, next);
      return copy(next);
    });
  }
}
