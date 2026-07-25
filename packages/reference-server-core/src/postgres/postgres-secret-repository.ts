// SPDX-License-Identifier: Apache-2.0

import {
  PostgresRepositoryContext,
  asRecord,
  selectRecord,
  type JsonRecordRow,
} from "./postgres-repository-context.js";
import type {
  SecretRepository,
  CreateSecretVersionInput,
  RotateSecretInput,
  SecretVersionRecord,
} from "../types.js";

export class PostgresSecretRepository implements SecretRepository {
  readonly #ctx: PostgresRepositoryContext;

  constructor(ctx: PostgresRepositoryContext) {
    this.#ctx = ctx;
  }

  async createSecretVersion(
    input: CreateSecretVersionInput,
  ): Promise<SecretVersionRecord> {
    const record: SecretVersionRecord = {
      ...input,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
    await this.#ctx.client().query(
      `INSERT INTO reference_secret_versions(
           id, endpoint_id, state, created_at, updated_at, record
         )
         VALUES ($1, $2, $3, $4, $4, $5::jsonb)`,
      [
        record.id,
        record.endpointId,
        record.state,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
    return record;
  }

  async rotateSecret(input: RotateSecretInput): Promise<SecretVersionRecord> {
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.repository.lockEndpoint(input.endpointId);
      const active = await this.#ctx.client().query<JsonRecordRow>(
        `SELECT record
           FROM reference_secret_versions
           WHERE endpoint_id = $1 AND state = 'active'
           FOR UPDATE`,
        [input.endpointId],
      );
      if (active.rows.length !== 1) {
        throw new Error("Secret rotation requires exactly one active secret.");
      }
      const secret = asRecord<SecretVersionRecord>(active.rows[0]!.record);
      const overlapping: SecretVersionRecord = {
        ...secret,
        state: "overlapping",
        expiresAt: input.overlapUntil,
        updatedAt: input.timestamp,
      };
      await this.#ctx.client().query(
        `UPDATE reference_secret_versions
           SET state = 'overlapping',
               updated_at = $2,
               record = $3::jsonb
           WHERE id = $1`,
        [secret.id, input.timestamp, JSON.stringify(overlapping)],
      );
      return this.createSecretVersion(input.replacement);
    });
  }

  async revokeSecret(
    endpointId: string,
    secretId: string,
    timestamp: string,
  ): Promise<SecretVersionRecord | undefined> {
    return this.#ctx.repository.transaction(async () => {
      const current = await selectRecord<SecretVersionRecord>(
        this.#ctx.client(),
        `SELECT record
           FROM reference_secret_versions
           WHERE id = $1 AND endpoint_id = $2
           FOR UPDATE`,
        [secretId, endpointId],
      );
      if (current === undefined || current.state === "revoked") {
        return current;
      }
      const next: SecretVersionRecord = {
        ...current,
        state: "revoked",
        updatedAt: timestamp,
      };
      await this.#ctx.client().query(
        `UPDATE reference_secret_versions
           SET state = 'revoked', updated_at = $2, record = $3::jsonb
           WHERE id = $1`,
        [secretId, timestamp, JSON.stringify(next)],
      );
      return next;
    });
  }

  async getSecretVersion(
    endpointId: string,
    secretId: string,
  ): Promise<SecretVersionRecord | undefined> {
    return selectRecord<SecretVersionRecord>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_secret_versions
         WHERE endpoint_id = $1 AND id = $2`,
      [endpointId, secretId],
    );
  }

  async listSecretVersions(
    endpointId: string,
  ): Promise<readonly SecretVersionRecord[]> {
    const result = await this.#ctx.client().query<JsonRecordRow>(
      `SELECT record
         FROM reference_secret_versions
         WHERE endpoint_id = $1
         ORDER BY created_at DESC, id DESC`,
      [endpointId],
    );
    return result.rows.map((row) => asRecord<SecretVersionRecord>(row.record));
  }
}
