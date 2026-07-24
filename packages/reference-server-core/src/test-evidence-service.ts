// SPDX-License-Identifier: Apache-2.0

import {
  type CanonicalMetadataRecord,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  canonicalizeMetadataRecord,
  type MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";

import { PayloadCleanupConflictError } from "./repository-errors.js";
import type { ReferenceServiceContext } from "./service-context.js";
import {
  ReferenceApiError,
  payloadCleanupApiError,
  pickEvent,
  safeFixture,
  sha256,
} from "./service-support.js";
import type {
  CreatePayloadUploadIntentInput,
  TestCommandRecord,
} from "./types.js";

interface TestPayloadUpload {
  readonly uploadAttempt: CreatePayloadUploadIntentInput | undefined;
  readonly uploaded: boolean;
}

export class TestEvidenceService {
  readonly #ctx: ReferenceServiceContext;

  constructor(ctx: ReferenceServiceContext) {
    this.#ctx = ctx;
  }

  async #testBody(command: TestCommandRecord): Promise<Buffer> {
    const release = await this.#ctx.repository.getRelease(
      command.context.releaseId,
    );
    if (release === undefined) {
      throw new Error("The immutable release for a test command is missing.");
    }
    const { version } = pickEvent(
      release.contract,
      command.eventType,
      command.context.eventVersion,
    );
    const body = Buffer.from(JSON.stringify(safeFixture(version)), "utf8");
    if (
      sha256(body) !== command.context.bodySha256 ||
      version.schema.checksum.value !== command.context.schemaChecksum ||
      version.publicVersion !== command.context.eventVersion
    ) {
      throw new Error("The immutable test request context is inconsistent.");
    }
    return body;
  }

  async completeTestEvidence(
    commandId: string,
    correlationId: string,
    suppliedBody?: Uint8Array,
  ): Promise<TestCommandRecord> {
    const command = await this.#ctx.repository.getTestCommand(commandId);
    if (command === undefined) {
      throw new ReferenceApiError(
        404,
        "TEST_COMMAND_NOT_FOUND",
        "The test command was not found.",
      );
    }
    if (command.evidenceState === "complete") {
      return command;
    }
    const result = command.pendingResult;
    const observedAt = command.resultObservedAt;
    if (result === undefined || observedAt === undefined) {
      throw new Error("The test command has no staged completion evidence.");
    }
    const body =
      suppliedBody === undefined
        ? await this.#testBody(command)
        : Buffer.from(suppliedBody);
    if (sha256(body) !== command.context.bodySha256) {
      throw new Error(
        "The supplied test body does not match its request context.",
      );
    }
    const status: MetadataDeliveryAttemptInput["status"] =
      result.state === "acknowledged"
        ? "delivered"
        : result.state === "unknown"
          ? "unknown"
          : "failed";
    const input: MetadataDeliveryAttemptInput = {
      attempt: 1,
      deliveryId: command.id,
      endpointId: command.endpointId,
      eventId: result.messageId ?? command.id,
      eventVersion: {
        eventType: command.eventType,
        schemaChecksum: command.context.schemaChecksum,
        version: command.context.eventVersion,
      },
      kind: "delivery_attempt",
      mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
      occurredAt: observedAt,
      schemaVersion: "2026-07-01",
      sequence: 1,
      status,
      ...(result.statusCode === undefined
        ? {}
        : { responseStatusCode: result.statusCode }),
      ...(result.errorCategory === undefined
        ? {}
        : { errorCode: result.errorCategory }),
    };
    const record = canonicalizeMetadataRecord(
      input,
      this.#ctx.config.metadataIdentity,
    );
    const upload = await this.#uploadTestPayload(command, body);
    return this.#commitTestEvidence(
      commandId,
      correlationId,
      command,
      observedAt,
      record,
      command.context.payload !== undefined,
      upload,
    );
  }

  async #uploadTestPayload(
    command: TestCommandRecord,
    body: Buffer,
  ): Promise<TestPayloadUpload> {
    const payload = command.context.payload;
    let uploadAttempt: CreatePayloadUploadIntentInput | undefined;
    let uploaded = false;
    if (payload !== undefined) {
      const createdAt = this.#ctx.nowIso();
      const uploadAttemptId = this.#ctx.idFactory();
      const uploadGeneration = this.#ctx.idFactory();
      const objectKey = [
        "payloads",
        "local",
        encodeURIComponent(command.endpointId),
        encodeURIComponent(command.id),
        encodeURIComponent(uploadAttemptId),
        encodeURIComponent(uploadGeneration),
      ].join("/");
      uploadAttempt = {
        id: uploadAttemptId,
        uploadAttemptId,
        uploadGeneration,
        objectKey,
        contentType: payload.contentType,
        size: payload.size,
        createdAt,
        expiresAt: new Date(
          Date.parse(createdAt) + payload.ttlSeconds * 1000,
        ).toISOString(),
        endpointId: command.endpointId,
        deliveryId: command.id,
      };
      try {
        await this.#ctx.repository.createPayloadUploadIntent(uploadAttempt);
      } catch (error) {
        if (error instanceof PayloadCleanupConflictError) {
          throw payloadCleanupApiError(error);
        }
        throw error;
      }
      try {
        await this.#ctx.payloadStorage.put({
          objectKey: uploadAttempt.objectKey,
          bytes: body,
          contentType: uploadAttempt.contentType,
          createdAt: uploadAttempt.createdAt,
          expiresAt: uploadAttempt.expiresAt,
        });
        uploaded = true;
      } catch (error) {
        if (error instanceof PayloadCleanupConflictError) {
          throw payloadCleanupApiError(error);
        }
        try {
          await this.#ctx.payloadStorage.delete(uploadAttempt.objectKey);
          await this.#ctx.repository.completePayloadUploadIntent(
            uploadAttempt.id,
            uploadAttempt.uploadGeneration,
          );
        } catch (cleanupError) {
          try {
            await this.#ctx.repository.markPayloadUploadIntentOrphaned(
              uploadAttempt.id,
              uploadAttempt.uploadGeneration,
              this.#ctx.nowIso(),
              cleanupError instanceof Error
                ? cleanupError.name
                : "payload_cleanup_failed",
            );
          } catch (markError) {
            throw new AggregateError(
              [error, cleanupError, markError],
              "Payload upload failed and its durable orphan state could not be updated.",
            );
          }
          throw new AggregateError(
            [error, cleanupError],
            "Payload upload failed and compensation remains pending.",
          );
        }
        throw error;
      }
    }
    return { uploadAttempt, uploaded };
  }

  async #commitTestEvidence(
    commandId: string,
    correlationId: string,
    command: TestCommandRecord,
    observedAt: string,
    record: CanonicalMetadataRecord,
    payloadRetained: boolean,
    upload: TestPayloadUpload,
  ): Promise<TestCommandRecord> {
    const { uploadAttempt, uploaded } = upload;
    try {
      return await this.#ctx.repository.transaction(async (repository) => {
        await repository.acquireTimelineEvidenceLocks({
          commandIds: [commandId],
          records: [record],
        });
        const endpoint = await repository.lockEndpoint(command.endpointId);
        if (endpoint === undefined || endpoint.state === "deleted") {
          throw new Error(
            "The endpoint was deleted during test evidence completion.",
          );
        }
        const current = await repository.lockTestCommand(commandId);
        if (current === undefined) {
          throw new Error("The test command disappeared during completion.");
        }
        if (current.evidenceState === "complete") {
          return current;
        }
        if (
          current.pendingResult === undefined ||
          current.resultObservedAt === undefined
        ) {
          throw new Error("The staged test result disappeared.");
        }
        await repository.ingestMetadata([record], observedAt);
        if (uploadAttempt !== undefined) {
          await repository.createPayloadReference({
            id: uploadAttempt.id,
            uploadAttemptId: uploadAttempt.uploadAttemptId,
            uploadGeneration: uploadAttempt.uploadGeneration,
            objectKey: uploadAttempt.objectKey,
            contentType: uploadAttempt.contentType,
            size: uploadAttempt.size,
            createdAt: uploadAttempt.createdAt,
            expiresAt: uploadAttempt.expiresAt,
            endpointId: current.endpointId,
            deliveryId: current.id,
          });
          await repository.completePayloadUploadIntent(
            uploadAttempt.id,
            uploadAttempt.uploadGeneration,
          );
        }
        const completed = await repository.completeTestCommand(
          commandId,
          this.#ctx.nowIso(),
        );
        if (completed === undefined || completed.result === undefined) {
          throw new Error("The test command did not complete.");
        }
        await this.#ctx.audit(
          {
            action: "test.send",
            resourceType: "test_command",
            resourceId: completed.id,
            result:
              completed.result.state === "acknowledged"
                ? "success"
                : completed.result.state === "unknown"
                  ? "unknown"
                  : completed.result.state === "rejected_before_dispatch"
                    ? "denied"
                    : "failure",
            correlationId,
            details: {
              endpointId: completed.endpointId,
              eventType: completed.eventType,
              state: completed.result.state,
              releaseId: completed.context.releaseId,
              ...(completed.result.statusCode === undefined
                ? {}
                : { statusCode: completed.result.statusCode }),
            },
          },
          repository,
        );
        await this.#ctx.outbox(
          {
            topic: "test.completed",
            aggregateType: "test_command",
            aggregateId: completed.id,
            correlationId,
            payload: {
              state: completed.result.state,
              deliveryId: completed.id,
              payloadRetained: payloadRetained,
            },
          },
          repository,
        );
        return completed;
      });
    } catch (error) {
      return this.#recoverFailedTestEvidenceCommit(
        error,
        commandId,
        uploadAttempt,
        uploaded,
      );
    }
  }

  async #recoverFailedTestEvidenceCommit(
    error: unknown,
    commandId: string,
    uploadAttempt: CreatePayloadUploadIntentInput | undefined,
    uploaded: boolean,
  ): Promise<TestCommandRecord> {
    if (error instanceof PayloadCleanupConflictError) {
      throw payloadCleanupApiError(error);
    }
    try {
      const persisted = await this.#ctx.repository.getTestCommand(commandId);
      const payloadReference =
        uploadAttempt === undefined
          ? undefined
          : await this.#ctx.repository.getPayloadReference(uploadAttempt.id);
      const uploadIntent =
        uploadAttempt === undefined
          ? undefined
          : await this.#ctx.repository.getPayloadUploadIntent(uploadAttempt.id);
      if (
        persisted?.evidenceState === "complete" &&
        (uploadAttempt === undefined ||
          (payloadReference !== undefined && uploadIntent === undefined))
      ) {
        return persisted;
      }
      if (
        persisted?.evidenceState === "complete" ||
        payloadReference !== undefined
      ) {
        throw new Error(
          "Test completion evidence is partially persisted after an ambiguous transaction outcome.",
        );
      }
    } catch (verificationError) {
      throw new AggregateError(
        [error, verificationError],
        "Test evidence transaction outcome is unknown; payload compensation was not attempted.",
      );
    }
    if (uploaded && uploadAttempt !== undefined) {
      try {
        await this.#ctx.payloadStorage.delete(uploadAttempt.objectKey);
        await this.#ctx.repository.completePayloadUploadIntent(
          uploadAttempt.id,
          uploadAttempt.uploadGeneration,
        );
      } catch (cleanupError) {
        try {
          await this.#ctx.repository.markPayloadUploadIntentOrphaned(
            uploadAttempt.id,
            uploadAttempt.uploadGeneration,
            this.#ctx.nowIso(),
            cleanupError instanceof Error
              ? cleanupError.name
              : "payload_cleanup_failed",
          );
        } catch (markError) {
          throw new AggregateError(
            [error, cleanupError, markError],
            "Test evidence persistence failed and payload orphan state could not be updated.",
          );
        }
        throw new AggregateError(
          [error, cleanupError],
          "Test evidence persistence failed and payload compensation remains pending.",
        );
      }
    }
    throw error;
  }
}
