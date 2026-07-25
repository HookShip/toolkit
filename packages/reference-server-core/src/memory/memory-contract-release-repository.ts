// SPDX-License-Identifier: Apache-2.0

import { compareNumbers } from "../ordering.js";
import { releaseMetadata } from "../release-metadata.js";
import {
  InMemoryRepositoryState,
  activeRelease,
  copy,
} from "./memory-repository-state.js";
import type {
  ContractRepository,
  ReleaseRepository,
  ContractImportRecord,
  PublishCommandRecord,
  PublishReleaseInput,
  PublishStatus,
  ReleaseMetadataPage,
  ReleaseRecord,
} from "../types.js";

export class InMemoryContractReleaseRepository
  implements ContractRepository, ReleaseRepository
{
  readonly #ctx: InMemoryRepositoryState;

  constructor(ctx: InMemoryRepositoryState) {
    this.#ctx = ctx;
  }

  async createContractImport(record: ContractImportRecord): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("createContractImport");
      if (state.imports.has(record.id)) {
        throw new Error(`Contract import "${record.id}" already exists.`);
      }
      state.imports.set(record.id, copy(record));
    });
  }

  async getContractImport(
    id: string,
  ): Promise<ContractImportRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.imports.get(id);
      return value === undefined ? undefined : copy(value);
    });
  }

  async lockReleaseState(): Promise<ReleaseRecord | undefined> {
    return this.getActiveRelease();
  }

  async publishRelease(input: PublishReleaseInput): Promise<ReleaseRecord> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("publishRelease");
      const contract = input.importRecord.contract;
      const canonicalExport = input.importRecord.canonicalExport;
      if (contract === undefined || canonicalExport === undefined) {
        throw new Error(
          "Cannot publish an import without a canonical contract.",
        );
      }
      if (state.releases.has(input.id)) {
        throw new Error(`Release "${input.id}" already exists.`);
      }
      const stored: ReleaseRecord = {
        id: input.id,
        importId: input.importRecord.id,
        sequence: state.nextReleaseSequence,
        createdAt: input.createdAt,
        active: false,
        checksum: contract.checksum.value,
        contract: copy(contract),
        canonicalExport: copy(canonicalExport),
        changelog: copy(input.changelog),
        ...(input.compatibility === undefined
          ? {}
          : { compatibility: copy(input.compatibility) }),
        ...(input.overrideReason === undefined
          ? {}
          : { overrideReason: input.overrideReason }),
      };
      if (state.activeReleaseId !== undefined) {
        const previous = state.releaseMetadata.get(state.activeReleaseId);
        if (previous !== undefined) {
          state.releaseMetadata.set(previous.id, {
            ...previous,
            status: "superseded",
          });
        }
      }
      state.nextReleaseSequence += 1;
      state.releases.set(stored.id, stored);
      state.activeReleaseId = stored.id;
      const active = activeRelease(stored, state.activeReleaseId);
      state.releaseMetadata.set(stored.id, releaseMetadata(active));
      return active;
    });
  }

  async getActiveRelease(): Promise<ReleaseRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      if (state.activeReleaseId === undefined) {
        return undefined;
      }
      const value = state.releases.get(state.activeReleaseId);
      return value === undefined
        ? undefined
        : activeRelease(value, state.activeReleaseId);
    });
  }

  async getRelease(id: string): Promise<ReleaseRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.releases.get(id);
      return value === undefined
        ? undefined
        : activeRelease(value, state.activeReleaseId);
    });
  }

  async listReleases(): Promise<readonly ReleaseRecord[]> {
    return this.#ctx.withState(async (state) =>
      [...state.releases.values()]
        .sort((left, right) => compareNumbers(right.sequence, left.sequence))
        .map((record) => activeRelease(record, state.activeReleaseId)),
    );
  }

  async listReleaseMetadataPage(
    limit: number,
    beforeSequence?: number,
  ): Promise<ReleaseMetadataPage> {
    return this.#ctx.withState(async (state) => {
      const matches = [...state.releaseMetadata.values()]
        .filter(
          (release) =>
            beforeSequence === undefined ||
            compareNumbers(release.sequence, beforeSequence) < 0,
        )
        .sort((left, right) => compareNumbers(right.sequence, left.sequence))
        .slice(0, limit + 1);
      const items = matches.slice(0, limit).map(copy);
      const last = items.at(-1);
      return {
        items,
        ...(matches.length > limit && last !== undefined
          ? { nextBeforeSequence: last.sequence }
          : {}),
      };
    });
  }

  async createPublishCommand(record: PublishCommandRecord): Promise<void> {
    await this.#ctx.withState(async (state) => {
      await this.#ctx.fault("createPublishCommand");
      if (state.publishCommands.has(record.idempotencyKey)) {
        throw new Error(
          `Publish idempotency key "${record.idempotencyKey}" already exists.`,
        );
      }
      state.publishCommands.set(record.idempotencyKey, copy(record));
    });
  }

  async getPublishCommand(
    idempotencyKey: string,
  ): Promise<PublishCommandRecord | undefined> {
    return this.#ctx.withState(async (state) => {
      const value = state.publishCommands.get(idempotencyKey);
      return value === undefined ? undefined : copy(value);
    });
  }

  async getPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    const command = await this.getPublishCommand(idempotencyKey);
    if (command === undefined) {
      return { status: "not_found", idempotencyKey };
    }
    if (command.state !== "completed" || command.releaseId === undefined) {
      return { status: "pending", idempotencyKey, command };
    }
    const release = await this.getRelease(command.releaseId);
    return release === undefined
      ? {
          status: "inconsistent",
          idempotencyKey,
          command,
          reason: "release_not_found",
        }
      : { status: "completed", idempotencyKey, command, release };
  }

  async recoverPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    await this.#ctx.fault("recoverPublishStatus");
    return this.getPublishStatus(idempotencyKey);
  }

  async completePublishCommand(
    id: string,
    releaseId: string,
    predecessorReleaseId: string | undefined,
    timestamp: string,
  ): Promise<PublishCommandRecord> {
    return this.#ctx.withState(async (state) => {
      await this.#ctx.fault("completePublishCommand");
      const entry = [...state.publishCommands.entries()].find(
        ([, command]) => command.id === id,
      );
      if (entry === undefined) {
        throw new Error(`Publish command "${id}" was not found.`);
      }
      const [key, current] = entry;
      if (current.state === "completed") {
        if (current.releaseId !== releaseId) {
          throw new Error("A completed publish command cannot be changed.");
        }
        return copy(current);
      }
      const next: PublishCommandRecord = {
        ...current,
        state: "completed",
        releaseId,
        updatedAt: timestamp,
        ...(predecessorReleaseId === undefined ? {} : { predecessorReleaseId }),
      };
      state.publishCommands.set(key, next);
      return copy(next);
    });
  }
}
