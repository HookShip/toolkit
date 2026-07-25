// SPDX-License-Identifier: Apache-2.0

import {
  PostgresRepositoryContext,
  selectRecord,
  validatePayloadStorageBinding,
} from "./postgres-repository-context.js";
import type { PayloadStorageNamespaceState } from "../types.js";

export class PostgresPayloadNamespaceRepository {
  readonly #ctx: PostgresRepositoryContext;

  constructor(ctx: PostgresRepositoryContext) {
    this.#ctx = ctx;
  }

  async getPayloadStorageNamespace(): Promise<
    PayloadStorageNamespaceState | undefined
  > {
    return selectRecord<PayloadStorageNamespaceState>(
      this.#ctx.client(),
      `SELECT record
         FROM reference_payload_storage_state
         WHERE singleton = true`,
      [],
    );
  }

  async initializePayloadStorageNamespace(
    namespace: string,
    storeId: string,
    timestamp: string,
  ): Promise<PayloadStorageNamespaceState> {
    validatePayloadStorageBinding(namespace, storeId);
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.client().query(
        `SELECT pg_advisory_xact_lock(
             hashtextextended('webhook-portal-payload-storage-namespace', 0)
           )`,
      );
      const current = await selectRecord<PayloadStorageNamespaceState>(
        this.#ctx.client(),
        `SELECT record
           FROM reference_payload_storage_state
           WHERE singleton = true
           FOR UPDATE`,
        [],
      );
      if (current !== undefined) {
        if (current.namespace !== namespace) {
          throw new Error("Payload storage namespace does not match.");
        }
        if (current.storeId !== undefined && current.storeId !== storeId) {
          throw new Error("Payload storage store ID does not match.");
        }
        if (current.storeId === undefined) {
          const claimed: PayloadStorageNamespaceState = {
            ...current,
            storeId,
            status: current.status === "ready" ? "upgrading" : current.status,
            updatedAt: timestamp,
          };
          await this.#ctx.client().query(
            `UPDATE reference_payload_storage_state
               SET store_id = $2,
                   status = $3,
                   updated_at = $4,
                   record = $5::jsonb
               WHERE singleton = true
                 AND namespace = $1
                 AND store_id IS NULL`,
            [
              namespace,
              storeId,
              claimed.status,
              timestamp,
              JSON.stringify(claimed),
            ],
          );
          return claimed;
        }
        return current;
      }
      const created: PayloadStorageNamespaceState = {
        namespace,
        storeId,
        status: "binding",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.#ctx.client().query(
        `INSERT INTO reference_payload_storage_state(
             singleton, namespace, store_id, status, created_at, updated_at, record
           )
           VALUES (true, $1, $2, 'binding', $3, $3, $4::jsonb)`,
        [namespace, storeId, timestamp, JSON.stringify(created)],
      );
      return created;
    });
  }

  async markPayloadStorageNamespaceReady(
    namespace: string,
    storeId: string,
    timestamp: string,
  ): Promise<PayloadStorageNamespaceState> {
    validatePayloadStorageBinding(namespace, storeId);
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.client().query(
        `SELECT pg_advisory_xact_lock(
             hashtextextended('webhook-portal-payload-storage-namespace', 0)
           )`,
      );
      const current = await this.getPayloadStorageNamespace();
      if (
        current === undefined ||
        current.namespace !== namespace ||
        current.storeId !== storeId
      ) {
        throw new Error("Payload storage binding does not match.");
      }
      const ready: PayloadStorageNamespaceState = {
        ...current,
        status: "ready",
        updatedAt: timestamp,
      };
      await this.#ctx.client().query(
        `UPDATE reference_payload_storage_state
           SET status = 'ready', updated_at = $2, record = $3::jsonb
           WHERE singleton = true
             AND namespace = $1
             AND store_id = $4`,
        [namespace, timestamp, JSON.stringify(ready), storeId],
      );
      return ready;
    });
  }

  async hasPayloadDataState(): Promise<boolean> {
    const result = await this.#ctx
      .client()
      .query<{ readonly present: boolean }>(
        `SELECT (
           EXISTS (SELECT 1 FROM reference_payload_references)
           OR EXISTS (SELECT 1 FROM reference_payload_upload_intents)
           OR EXISTS (SELECT 1 FROM reference_payload_cleanup_claims)
           OR EXISTS (SELECT 1 FROM reference_payload_cleanup_tasks)
         ) AS present`,
      );
    return result.rows[0]?.present ?? false;
  }

  async hasPayloadPersistenceState(): Promise<boolean> {
    const result = await this.#ctx
      .client()
      .query<{ readonly present: boolean }>(
        `SELECT (
           EXISTS (SELECT 1 FROM reference_payload_storage_state)
           OR EXISTS (SELECT 1 FROM reference_payload_references)
           OR EXISTS (SELECT 1 FROM reference_payload_upload_intents)
           OR EXISTS (SELECT 1 FROM reference_payload_cleanup_claims)
           OR EXISTS (SELECT 1 FROM reference_payload_cleanup_tasks)
         ) AS present`,
      );
    return result.rows[0]?.present ?? false;
  }
}
