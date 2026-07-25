// SPDX-License-Identifier: Apache-2.0

import {
  PostgresRepositoryContext,
  asRecord,
  selectRecord,
  type JsonRecordRow,
} from "./postgres-repository-context.js";
import type {
  EndpointRepository,
  CreateEndpointInput,
  EndpointDeletionResult,
  EndpointRecord,
  EndpointTombstone,
  PayloadCleanupTask,
  PayloadReference,
  PayloadUploadIntent,
  SetSubscriptionInput,
  SubscriptionRecord,
  UpdateEndpointInput,
} from "../types.js";

export class PostgresEndpointRepository implements EndpointRepository {
  readonly #ctx: PostgresRepositoryContext;

  constructor(ctx: PostgresRepositoryContext) {
    this.#ctx = ctx;
  }

  async createEndpoint(input: CreateEndpointInput): Promise<EndpointRecord> {
    const endpoint: EndpointRecord = {
      id: input.id,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      url: input.url,
      allowLocalNetwork: input.allowLocalNetwork,
      state: "active",
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
    };
    await this.#ctx.client().query(
      `INSERT INTO reference_endpoints(
           id, state, url, created_at, updated_at, record
         )
         VALUES ($1, $2, $3, $4, $4, $5::jsonb)`,
      [
        endpoint.id,
        endpoint.state,
        endpoint.url,
        endpoint.createdAt,
        JSON.stringify(endpoint),
      ],
    );
    return endpoint;
  }

  async getEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return selectRecord<EndpointRecord>(
      this.#ctx.client(),
      "SELECT record FROM reference_endpoints WHERE id = $1",
      [id],
    );
  }

  async lockEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return selectRecord<EndpointRecord>(
      this.#ctx.client(),
      "SELECT record FROM reference_endpoints WHERE id = $1 FOR UPDATE",
      [id],
    );
  }

  async listEndpoints(): Promise<readonly EndpointRecord[]> {
    const result = await this.#ctx
      .client()
      .query<JsonRecordRow>(
        "SELECT record FROM reference_endpoints ORDER BY created_at, id",
      );
    return result.rows.map((row) => asRecord<EndpointRecord>(row.record));
  }

  async updateEndpoint(
    id: string,
    input: UpdateEndpointInput,
  ): Promise<EndpointRecord | undefined> {
    return this.#ctx.repository.transaction(async () => {
      const current = await this.#ctx.repository.lockEndpoint(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.state === "deleted") {
        return current;
      }
      if (input.state === "deleted") {
        throw new Error("Use deleteEndpointData to tombstone an endpoint.");
      }
      const next: EndpointRecord = {
        ...current,
        updatedAt: input.updatedAt,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.allowLocalNetwork === undefined
          ? {}
          : { allowLocalNetwork: input.allowLocalNetwork }),
        ...(input.state === undefined ? {} : { state: input.state }),
      };
      const normalized =
        input.description === null
          ? Object.fromEntries(
              Object.entries(next).filter(([key]) => key !== "description"),
            )
          : input.description === undefined
            ? next
            : { ...next, description: input.description };
      const record = asRecord<EndpointRecord>(normalized);
      if (record.state === "deleted") {
        throw new Error("Endpoint updates cannot create tombstones.");
      }
      await this.#ctx.client().query(
        `UPDATE reference_endpoints
           SET state = $2,
               url = $3,
               updated_at = $4,
               record = $5::jsonb
           WHERE id = $1`,
        [
          id,
          record.state,
          record.url,
          record.updatedAt,
          JSON.stringify(record),
        ],
      );
      return record;
    });
  }

  async deleteEndpointData(
    id: string,
    timestamp: string,
  ): Promise<EndpointDeletionResult | undefined> {
    return this.#ctx.repository.transaction(async () => {
      await this.#ctx.repository.acquireTimelineEvidenceLocks({
        endpointIds: [id],
      });
      const current = await this.#ctx.repository.lockEndpoint(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.state === "deleted") {
        return {
          endpoint: current,
          cleanupTasks: await this.#ctx.repository.listPayloadCleanupTasks(
            10_000,
            id,
          ),
          newlyDeleted: false,
        };
      }

      const references = await this.#ctx.client().query<JsonRecordRow>(
        `SELECT payload.record
           FROM reference_payload_references AS payload
           WHERE payload.endpoint_id = $1
              OR (
                payload.endpoint_id IS NULL
                AND payload.delivery_id IN (
                  SELECT delivery_id
                  FROM reference_metadata_timeline
                  WHERE endpoint_id = $1
                )
              )
           FOR UPDATE`,
        [id],
      );
      for (const row of references.rows) {
        const reference = asRecord<PayloadReference>(row.record);
        const task: PayloadCleanupTask = {
          id: `endpoint:${reference.id}`,
          objectKey: reference.objectKey,
          reason: "endpoint_deleted",
          state: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          endpointId: id,
        };
        await this.#ctx.client().query(
          `INSERT INTO reference_payload_cleanup_tasks(
               id, object_key, endpoint_id, state, reason,
               created_at, updated_at, attempts, record
             )
             VALUES ($1, $2, $3, 'pending', 'endpoint_deleted',
                     $4, $4, 0, $5::jsonb)
             ON CONFLICT(id) DO NOTHING`,
          [task.id, task.objectKey, id, timestamp, JSON.stringify(task)],
        );
        const deletedReference = await this.#ctx.client().query(
          `DELETE FROM reference_payload_references
             WHERE id = $1
               AND object_key = $2
               AND upload_attempt_id IS NOT DISTINCT FROM $3
               AND upload_generation IS NOT DISTINCT FROM $4`,
          [
            reference.id,
            reference.objectKey,
            reference.uploadAttemptId ?? null,
            reference.uploadGeneration ?? null,
          ],
        );
        if (deletedReference.rowCount !== 1) {
          throw new Error(
            "Payload reference generation changed during endpoint deletion.",
          );
        }
      }
      const intents = await this.#ctx.client().query<JsonRecordRow>(
        `SELECT record
           FROM reference_payload_upload_intents
           WHERE endpoint_id = $1
           FOR UPDATE`,
        [id],
      );
      for (const row of intents.rows) {
        const intent = asRecord<PayloadUploadIntent>(row.record);
        const task: PayloadCleanupTask = {
          id: `endpoint:${intent.id}`,
          objectKey: intent.objectKey,
          reason: "endpoint_deleted",
          state: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          endpointId: id,
        };
        await this.#ctx.client().query(
          `INSERT INTO reference_payload_cleanup_tasks(
               id, object_key, endpoint_id, state, reason,
               created_at, updated_at, attempts, record
             )
             VALUES ($1, $2, $3, 'pending', 'endpoint_deleted',
                     $4, $4, 0, $5::jsonb)
             ON CONFLICT(id) DO NOTHING`,
          [task.id, task.objectKey, id, timestamp, JSON.stringify(task)],
        );
        const orphaned: PayloadUploadIntent = {
          ...intent,
          state: "orphaned",
          updatedAt: timestamp,
        };
        await this.#ctx.client().query(
          `UPDATE reference_payload_upload_intents
             SET state = 'orphaned', updated_at = $2, record = $3::jsonb
             WHERE id = $1`,
          [intent.id, timestamp, JSON.stringify(orphaned)],
        );
      }

      await this.#ctx.client().query(
        `DELETE FROM reference_metadata_observations AS observation
           USING reference_metadata_timeline AS timeline
           WHERE observation.identity_key = timeline.identity_key
             AND timeline.endpoint_id = $1`,
        [id],
      );
      await this.#ctx
        .client()
        .query(
          "DELETE FROM reference_metadata_timeline WHERE endpoint_id = $1",
          [id],
        );
      await this.#ctx
        .client()
        .query("DELETE FROM reference_subscriptions WHERE endpoint_id = $1", [
          id,
        ]);
      await this.#ctx
        .client()
        .query("DELETE FROM reference_secret_versions WHERE endpoint_id = $1", [
          id,
        ]);
      await this.#ctx
        .client()
        .query("DELETE FROM reference_test_commands WHERE endpoint_id = $1", [
          id,
        ]);

      const tombstone: EndpointTombstone = {
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: timestamp,
        deletedAt: timestamp,
        state: "deleted",
        tombstoneVersion: 1,
      };
      await this.#ctx.client().query(
        `UPDATE reference_endpoints
           SET state = 'deleted',
               url = NULL,
               deleted_at = $2,
               updated_at = $2,
               record = $3::jsonb
           WHERE id = $1`,
        [id, timestamp, JSON.stringify(tombstone)],
      );
      return {
        endpoint: tombstone,
        cleanupTasks: await this.#ctx.repository.listPayloadCleanupTasks(
          10_000,
          id,
        ),
        newlyDeleted: true,
      };
    });
  }

  async setSubscription(
    input: SetSubscriptionInput,
  ): Promise<SubscriptionRecord> {
    return this.#ctx.repository.transaction(async () => {
      const endpoint = await this.#ctx.repository.lockEndpoint(
        input.endpointId,
      );
      if (endpoint === undefined || endpoint.state === "deleted") {
        throw new Error("Cannot subscribe a missing or deleted endpoint.");
      }
      const current = await this.getSubscription(input.endpointId);
      const record: SubscriptionRecord = {
        id: current?.id ?? input.id,
        endpointId: input.endpointId,
        eventTypes: [...input.eventTypes],
        state: input.state,
        createdAt: current?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
      };
      await this.#ctx.client().query(
        `INSERT INTO reference_subscriptions(endpoint_id, updated_at, record)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT(endpoint_id) DO UPDATE
           SET updated_at = EXCLUDED.updated_at, record = EXCLUDED.record`,
        [input.endpointId, input.timestamp, JSON.stringify(record)],
      );
      return record;
    });
  }

  async getSubscription(
    endpointId: string,
  ): Promise<SubscriptionRecord | undefined> {
    return selectRecord<SubscriptionRecord>(
      this.#ctx.client(),
      "SELECT record FROM reference_subscriptions WHERE endpoint_id = $1",
      [endpointId],
    );
  }
}
