// SPDX-License-Identifier: Apache-2.0

import { releaseMetadata } from "../release-metadata.js";
import {
  PostgresRepositoryContext,
  asRecord,
  materializeRelease,
  selectRecord,
  type JsonRecordRow,
  type ReleaseStateRow,
  type Queryable,
} from "./postgres-repository-context.js";
import type {
  ContractRepository,
  ReleaseRepository,
  ContractImportRecord,
  PublishCommandRecord,
  PublishReleaseInput,
  PublishStatus,
  ReleaseMetadata,
  ReleaseMetadataPage,
  ReleaseRecord,
} from "../types.js";

export class PostgresContractReleaseRepository
  implements ContractRepository, ReleaseRepository
{
  readonly #ctx: PostgresRepositoryContext;

  constructor(ctx: PostgresRepositoryContext) {
    this.#ctx = ctx;
  }

  async createContractImport(record: ContractImportRecord): Promise<void> {
    await this.#ctx.client().query(
      `INSERT INTO reference_contract_imports(id, created_at, record)
         VALUES ($1, $2, $3::jsonb)`,
      [record.id, record.createdAt, JSON.stringify(record)],
    );
  }

  async getContractImport(
    id: string,
  ): Promise<ContractImportRecord | undefined> {
    return selectRecord<ContractImportRecord>(
      this.#ctx.client(),
      "SELECT record FROM reference_contract_imports WHERE id = $1",
      [id],
    );
  }

  async lockReleaseState(): Promise<ReleaseRecord | undefined> {
    const result = await this.#ctx.client().query<ReleaseStateRow>(
      `SELECT active_release_id, next_sequence
         FROM reference_release_state
         WHERE singleton = true
         FOR UPDATE`,
    );
    const state = result.rows[0];
    if (state === undefined) {
      throw new Error("Reference release state is not initialized.");
    }
    if (state.active_release_id === null) {
      return undefined;
    }
    const record = await selectRecord<ReleaseRecord>(
      this.#ctx.client(),
      "SELECT record FROM reference_releases WHERE id = $1",
      [state.active_release_id],
    );
    if (record === undefined) {
      throw new Error("The active release pointer is inconsistent.");
    }
    return materializeRelease(record, state.active_release_id);
  }

  async publishRelease(input: PublishReleaseInput): Promise<ReleaseRecord> {
    return this.#ctx.repository.transaction(async () => {
      const contract = input.importRecord.contract;
      const canonicalExport = input.importRecord.canonicalExport;
      if (contract === undefined || canonicalExport === undefined) {
        throw new Error(
          "Cannot publish an import without a canonical contract.",
        );
      }
      const stateResult = await this.#ctx.client().query<ReleaseStateRow>(
        `SELECT active_release_id, next_sequence
           FROM reference_release_state
           WHERE singleton = true
           FOR UPDATE`,
      );
      const state = stateResult.rows[0];
      if (state === undefined) {
        throw new Error("Reference release state is not initialized.");
      }
      const sequence = Number(state.next_sequence);
      const stored: ReleaseRecord = {
        id: input.id,
        importId: input.importRecord.id,
        sequence,
        createdAt: input.createdAt,
        active: false,
        checksum: contract.checksum.value,
        contract,
        canonicalExport,
        changelog: input.changelog,
        ...(input.compatibility === undefined
          ? {}
          : { compatibility: input.compatibility }),
        ...(input.overrideReason === undefined
          ? {}
          : { overrideReason: input.overrideReason }),
      };
      await this.#ctx.client().query(
        `INSERT INTO reference_releases(
             id, sequence, active, created_at, record
           )
           VALUES ($1, $2, false, $3, $4::jsonb)`,
        [stored.id, sequence, stored.createdAt, JSON.stringify(stored)],
      );
      if (state.active_release_id !== null) {
        await this.#ctx.client().query(
          `UPDATE reference_release_summaries
             SET status = 'superseded',
                 record = jsonb_set(
                   record,
                   '{status}',
                   to_jsonb('superseded'::text),
                   true
                 )
             WHERE release_id = $1`,
          [state.active_release_id],
        );
      }
      const active = materializeRelease(stored, stored.id);
      const metadata = releaseMetadata(active);
      await this.#ctx.client().query(
        `INSERT INTO reference_release_summaries(
             release_id, sequence, status, record
           )
           VALUES ($1, $2, 'active', $3::jsonb)`,
        [stored.id, sequence, JSON.stringify(metadata)],
      );
      await this.#ctx.client().query(
        `UPDATE reference_release_state
           SET active_release_id = $1, next_sequence = $2
           WHERE singleton = true`,
        [stored.id, sequence + 1],
      );
      return active;
    });
  }

  async getActiveRelease(): Promise<ReleaseRecord | undefined> {
    const state = await this.#ctx.client().query<ReleaseStateRow>(
      `SELECT active_release_id, next_sequence
         FROM reference_release_state
         WHERE singleton = true`,
    );
    const activeReleaseId = state.rows[0]?.active_release_id;
    if (activeReleaseId === undefined || activeReleaseId === null) {
      return undefined;
    }
    const record = await selectRecord<ReleaseRecord>(
      this.#ctx.client(),
      "SELECT record FROM reference_releases WHERE id = $1",
      [activeReleaseId],
    );
    return record === undefined
      ? undefined
      : materializeRelease(record, activeReleaseId);
  }

  async getRelease(id: string): Promise<ReleaseRecord | undefined> {
    const result = await this.#ctx
      .client()
      .query<JsonRecordRow & ReleaseStateRow>(
        `SELECT release.record, state.active_release_id, state.next_sequence
         FROM reference_releases AS release
         CROSS JOIN reference_release_state AS state
         WHERE state.singleton = true AND release.id = $1`,
        [id],
      );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : materializeRelease(
          asRecord<ReleaseRecord>(row.record),
          row.active_release_id,
        );
  }

  async listReleases(): Promise<readonly ReleaseRecord[]> {
    const result = await this.#ctx
      .client()
      .query<JsonRecordRow & ReleaseStateRow>(
        `SELECT release.record, state.active_release_id, state.next_sequence
         FROM reference_releases AS release
         CROSS JOIN reference_release_state AS state
         WHERE state.singleton = true
         ORDER BY release.sequence DESC`,
      );
    return result.rows.map((row) =>
      materializeRelease(
        asRecord<ReleaseRecord>(row.record),
        row.active_release_id,
      ),
    );
  }

  async listReleaseMetadataPage(
    limit: number,
    beforeSequence?: number,
  ): Promise<ReleaseMetadataPage> {
    const result = await this.#ctx
      .client()
      .query<JsonRecordRow & { readonly sequence: string | number }>(
        `SELECT sequence, record
         FROM reference_release_summaries
         WHERE ($2::bigint IS NULL OR sequence < $2)
         ORDER BY sequence DESC
         LIMIT $1`,
        [limit + 1, beforeSequence ?? null],
      );
    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => asRecord<ReleaseMetadata>(row.record));
    const last = items.at(-1);
    return {
      items,
      ...(result.rows.length > limit && last !== undefined
        ? { nextBeforeSequence: last.sequence }
        : {}),
    };
  }

  async createPublishCommand(record: PublishCommandRecord): Promise<void> {
    await this.#ctx.client().query(
      `INSERT INTO reference_publish_commands(
           id, idempotency_key, request_fingerprint, import_id, state,
           release_id, created_at, updated_at, record
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8::jsonb)`,
      [
        record.id,
        record.idempotencyKey,
        record.requestFingerprint,
        record.importId,
        record.state,
        record.releaseId ?? null,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
  }

  async getPublishCommand(
    idempotencyKey: string,
  ): Promise<PublishCommandRecord | undefined> {
    return selectRecord<PublishCommandRecord>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_publish_commands
         WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
  }

  async #publishStatus(
    client: Queryable,
    idempotencyKey: string,
  ): Promise<PublishStatus> {
    const command = await selectRecord<PublishCommandRecord>(
      client,
      `SELECT record
         FROM reference_publish_commands
         WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (command === undefined) {
      return { status: "not_found", idempotencyKey };
    }
    if (command.state !== "completed" || command.releaseId === undefined) {
      return { status: "pending", idempotencyKey, command };
    }
    const result = await client.query<JsonRecordRow & ReleaseStateRow>(
      `SELECT release.record, state.active_release_id, state.next_sequence
         FROM reference_releases AS release
         CROSS JOIN reference_release_state AS state
         WHERE state.singleton = true AND release.id = $1`,
      [command.releaseId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return {
        status: "inconsistent",
        idempotencyKey,
        command,
        reason: "release_not_found",
      };
    }
    return {
      status: "completed",
      idempotencyKey,
      command,
      release: materializeRelease(
        asRecord<ReleaseRecord>(row.record),
        row.active_release_id,
      ),
    };
  }

  async getPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    return this.#publishStatus(this.#ctx.client(), idempotencyKey);
  }

  async recoverPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    const client = await this.#ctx.pool.connect();
    try {
      return await this.#publishStatus(client, idempotencyKey);
    } finally {
      client.release();
    }
  }

  async completePublishCommand(
    id: string,
    releaseId: string,
    predecessorReleaseId: string | undefined,
    timestamp: string,
  ): Promise<PublishCommandRecord> {
    const current = await selectRecord<PublishCommandRecord>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_publish_commands
         WHERE id = $1
         FOR UPDATE`,
      [id],
    );
    if (current === undefined) {
      throw new Error(`Publish command "${id}" was not found.`);
    }
    if (current.state === "completed") {
      if (current.releaseId !== releaseId) {
        throw new Error("A completed publish command cannot be changed.");
      }
      return current;
    }
    const next: PublishCommandRecord = {
      ...current,
      state: "completed",
      releaseId,
      updatedAt: timestamp,
      ...(predecessorReleaseId === undefined ? {} : { predecessorReleaseId }),
    };
    await this.#ctx.client().query(
      `UPDATE reference_publish_commands
         SET state = 'completed',
             release_id = $2,
             updated_at = $3,
             record = $4::jsonb
         WHERE id = $1`,
      [id, releaseId, timestamp, JSON.stringify(next)],
    );
    return next;
  }
}
