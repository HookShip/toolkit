// SPDX-License-Identifier: Apache-2.0

import type { ValidatedDestination } from "@webhook-portal/adapter-generic-http";
import { signWebhook } from "@webhook-portal/signing";

import type { ReferenceServiceContext } from "./service-context.js";
import type { SendTestServiceInput } from "./service.js";
import {
  ReferenceApiError,
  pickEvent,
  safeFixture,
  sha256,
} from "./service-support.js";
import { TestEvidenceService } from "./test-evidence-service.js";
import type {
  BeginTestCommandResult,
  SecretVersionRecord,
  TestCommandRecord,
  TestCommandResult,
} from "./types.js";

type PreparedTest =
  | ({
      readonly body: Buffer;
      readonly secret: SecretVersionRecord | undefined;
    } & BeginTestCommandResult)
  | { readonly status: "existing"; readonly command: TestCommandRecord }
  | { readonly status: "conflict"; readonly command: TestCommandRecord };

type ReadyPreparedTest = Extract<PreparedTest, { readonly status: "created" }>;

type DispatchTest =
  | { readonly status: "existing"; readonly command: TestCommandRecord }
  | {
      readonly status: "rejected";
      readonly command: TestCommandRecord;
      readonly result: TestCommandResult;
    }
  | {
      readonly status: "dispatched";
      readonly command: TestCommandRecord;
      readonly secret: SecretVersionRecord;
    };

type DispatchedTest = Extract<DispatchTest, { readonly status: "dispatched" }>;

export class TestDispatchService {
  readonly #ctx: ReferenceServiceContext;
  readonly #evidence: TestEvidenceService;

  constructor(ctx: ReferenceServiceContext) {
    this.#ctx = ctx;
    this.#evidence = new TestEvidenceService(ctx);
  }

  async sendTest(input: SendTestServiceInput): Promise<TestCommandRecord> {
    const fingerprint = sha256(
      JSON.stringify({
        endpointId: input.endpointId,
        eventType: input.eventType,
        eventVersion: input.eventVersion ?? null,
      }),
    );
    const prepared = await this.#prepareTest(input, fingerprint);
    if (prepared.status === "conflict") {
      throw new ReferenceApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different test request.",
      );
    }
    if (prepared.status === "existing") {
      return this.#resumeTestCommand(prepared.command, input.correlationId);
    }

    if (prepared.secret === undefined) {
      const result: TestCommandResult = {
        state: "rejected_before_dispatch",
        delivered: false,
        errorCategory: "secret_unavailable",
        detail: "No active, unexpired signing secret is available.",
      };
      return this.#stageAndCompleteTest(
        prepared.command.id,
        result,
        input.correlationId,
        prepared.body,
      );
    }

    let destination: ValidatedDestination;
    try {
      destination = await this.#ctx.validateEndpointDestination(
        prepared.command.context.endpointUrl,
        prepared.command.context.allowLocalNetwork,
      );
    } catch {
      const result: TestCommandResult = {
        state: "rejected_before_dispatch",
        delivered: false,
        errorCategory: "destination_policy",
        detail: "The destination failed validation before dispatch.",
      };
      return this.#stageAndCompleteTest(
        prepared.command.id,
        result,
        input.correlationId,
        prepared.body,
      );
    }

    const dispatch = await this.#dispatchTest(prepared, input);
    if (dispatch.status === "existing") {
      return this.#resumeTestCommand(dispatch.command, input.correlationId);
    }
    if (dispatch.status === "rejected") {
      return this.#stageAndCompleteTest(
        dispatch.command.id,
        dispatch.result,
        input.correlationId,
        prepared.body,
      );
    }

    const result = await this.#deliverTest(dispatch, prepared, destination);
    return this.#stageAndCompleteTest(
      dispatch.command.id,
      result,
      input.correlationId,
      prepared.body,
    );
  }

  async #prepareTest(
    input: SendTestServiceInput,
    fingerprint: string,
  ): Promise<PreparedTest> {
    const existing = await this.#ctx.repository.getTestCommandByIdempotency(
      input.endpointId,
      input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (existing.requestFingerprint !== fingerprint) {
        return { status: "conflict" as const, command: existing };
      }
      return { status: "existing" as const, command: existing };
    }

    return this.#runPreparationTransaction(input, fingerprint);
  }

  async #runPreparationTransaction(
    input: SendTestServiceInput,
    fingerprint: string,
  ): Promise<PreparedTest> {
    return this.#ctx.repository.transaction(async (repository) => {
      const raced = await repository.getTestCommandByIdempotency(
        input.endpointId,
        input.idempotencyKey,
      );
      if (raced !== undefined) {
        return raced.requestFingerprint === fingerprint
          ? { status: "existing" as const, command: raced }
          : { status: "conflict" as const, command: raced };
      }
      const endpoint = await repository.lockEndpoint(input.endpointId);
      if (endpoint === undefined || endpoint.state === "deleted") {
        throw new ReferenceApiError(
          404,
          "ENDPOINT_NOT_FOUND",
          "The endpoint was not found.",
        );
      }
      if (endpoint.state !== "active") {
        throw new ReferenceApiError(
          409,
          "ENDPOINT_NOT_ACTIVE",
          "The endpoint must be active before sending a test.",
        );
      }
      const subscription = await repository.getSubscription(endpoint.id);
      if (
        subscription === undefined ||
        !subscription.eventTypes.includes(input.eventType)
      ) {
        throw new ReferenceApiError(
          409,
          "EVENT_NOT_SUBSCRIBED",
          "The endpoint is not subscribed to the requested event type.",
        );
      }
      const release = await repository.getActiveRelease();
      if (release === undefined) {
        throw new ReferenceApiError(
          409,
          "NO_ACTIVE_RELEASE",
          "Publish a contract before sending a test.",
        );
      }
      const { version } = pickEvent(
        release.contract,
        input.eventType,
        input.eventVersion,
      );
      const payload = safeFixture(version);
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      if (body.byteLength > this.#ctx.config.sendTestBodyLimitBytes) {
        throw new ReferenceApiError(
          413,
          "TEST_BODY_TOO_LARGE",
          "The generated test body exceeds the configured limit.",
        );
      }
      const secret = (
        await this.#ctx.eligibleSecretRecords(endpoint.id, repository)
      )[0];
      const timestamp = this.#ctx.nowIso();
      const commandId = this.#ctx.idFactory();
      const messageId = `test_${this.#ctx.idFactory().replaceAll("-", "")}`;
      const context = {
        endpointUrl: endpoint.url,
        allowLocalNetwork: endpoint.allowLocalNetwork,
        releaseId: release.id,
        schemaChecksum: version.schema.checksum.value,
        eventVersion: version.publicVersion,
        bodySha256: sha256(body),
        messageId,
        ...(secret === undefined ? {} : { signingSecretId: secret.id }),
        ...(this.#ctx.config.payloadRetention.enabled
          ? {
              payload: {
                contentType: "application/json" as const,
                size: body.byteLength,
                ttlSeconds: this.#ctx.config.payloadRetention.ttlSeconds,
              },
            }
          : {}),
      };
      const started = await repository.beginTestCommand({
        id: commandId,
        endpointId: endpoint.id,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        context,
        timestamp,
      });
      if (started.status === "created") {
        await this.#ctx.audit(
          {
            action: "test.request",
            resourceType: "test_command",
            resourceId: started.command.id,
            result: "success",
            correlationId: input.correlationId,
            details: {
              endpointId: endpoint.id,
              eventType: input.eventType,
              releaseId: release.id,
            },
          },
          repository,
        );
        await this.#ctx.outbox(
          {
            topic: "test.requested",
            aggregateType: "test_command",
            aggregateId: started.command.id,
            correlationId: input.correlationId,
            payload: {
              endpointId: endpoint.id,
              eventType: input.eventType,
              releaseId: release.id,
            },
          },
          repository,
        );
      }
      return { ...started, body, secret };
    });
  }

  async #dispatchTest(
    prepared: ReadyPreparedTest,
    input: SendTestServiceInput,
  ): Promise<DispatchTest> {
    return this.#ctx.repository.transaction(async (repository) => {
      const endpoint = await repository.lockEndpoint(
        prepared.command.endpointId,
      );
      const command = await repository.lockTestCommand(prepared.command.id);
      if (command === undefined) {
        throw new ReferenceApiError(
          410,
          "TEST_COMMAND_REMOVED",
          "The test command was removed during endpoint deletion.",
        );
      }
      if (
        command.evidenceState === "complete" ||
        command.pendingResult !== undefined ||
        command.state !== "requested"
      ) {
        return { status: "existing" as const, command };
      }
      if (endpoint === undefined || endpoint.state !== "active") {
        return {
          status: "rejected" as const,
          command,
          result: {
            state: "rejected_before_dispatch",
            delivered: false,
            errorCategory: "endpoint_unavailable",
            detail: "The endpoint was paused or deleted before dispatch began.",
          } satisfies TestCommandResult,
        };
      }
      const secretId = command.context.signingSecretId;
      const secret =
        secretId === undefined
          ? undefined
          : await repository.getSecretVersion(command.endpointId, secretId);
      const eligible = await this.#ctx.eligibleSecretRecords(
        command.endpointId,
        repository,
      );
      if (
        secret === undefined ||
        !eligible.some((candidate) => candidate.id === secret.id)
      ) {
        return {
          status: "rejected" as const,
          command,
          result: {
            state: "rejected_before_dispatch",
            delivered: false,
            errorCategory: "secret_unavailable",
            detail:
              "The selected signing secret became unavailable before dispatch.",
          } satisfies TestCommandResult,
        };
      }
      const dispatched = await repository.markTestCommandDispatched(
        command.id,
        this.#ctx.nowIso(),
      );
      if (dispatched === undefined) {
        throw new Error("The test command disappeared before dispatch.");
      }
      await this.#ctx.audit(
        {
          action: "test.dispatch",
          resourceType: "test_command",
          resourceId: command.id,
          result: "success",
          correlationId: input.correlationId,
          details: { endpointId: command.endpointId },
        },
        repository,
      );
      await this.#ctx.outbox(
        {
          topic: "test.dispatched",
          aggregateType: "test_command",
          aggregateId: command.id,
          correlationId: input.correlationId,
          payload: { endpointId: command.endpointId },
        },
        repository,
      );
      return { status: "dispatched" as const, command: dispatched, secret };
    });
  }

  async #deliverTest(
    dispatch: DispatchedTest,
    prepared: ReadyPreparedTest,
    destination: ValidatedDestination,
  ): Promise<TestCommandResult> {
    const signed = signWebhook({
      messageId: dispatch.command.context.messageId,
      body: prepared.body,
      secret: this.#ctx.webhookSecret(dispatch.secret),
      clock: this.#ctx.clock,
    });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Test delivery deadline exceeded.")),
      this.#ctx.config.sendTestTimeoutMilliseconds,
    );
    timer.unref();

    let result: TestCommandResult;
    try {
      const response = await this.#ctx.transport({
        method: "POST",
        url: destination.url,
        resolvedAddresses: destination.addresses,
        signal: controller.signal,
        maxResponseBodyBytes: 64 * 1024,
        maxResponseHeaderBytes: 32 * 1024,
        headers: Object.freeze({
          ...signed.headers,
          "content-type": "application/webhook+json",
          "content-length": String(prepared.body.byteLength),
          "user-agent": "webhook-portal-reference/1",
          "webhook-test": "true",
        }),
        body: prepared.body,
      });
      const delivered = response.status >= 200 && response.status < 300;
      result = {
        state: delivered ? "acknowledged" : "failed",
        delivered,
        statusCode: response.status,
        messageId: dispatch.command.context.messageId,
        ...(delivered
          ? {}
          : {
              errorCategory: "http",
              detail: "The endpoint returned a non-success status.",
            }),
      };
    } catch {
      result = {
        state: "unknown",
        delivered: false,
        messageId: dispatch.command.context.messageId,
        errorCategory: controller.signal.aborted ? "timeout" : "network",
        detail:
          "The request was dispatched, but the final delivery outcome is unknown.",
      };
    } finally {
      clearTimeout(timer);
    }
    return result;
  }

  async #resumeTestCommand(
    command: TestCommandRecord,
    correlationId: string,
  ): Promise<TestCommandRecord> {
    if (command.evidenceState === "complete") {
      return command;
    }
    if (command.pendingResult !== undefined) {
      return this.#completeTestEvidence(command.id, correlationId);
    }
    const age = this.#ctx.nowMilliseconds() - Date.parse(command.updatedAt);
    if (age < this.#ctx.config.sendTestTimeoutMilliseconds) {
      return command;
    }
    const result: TestCommandResult =
      command.state === "requested"
        ? {
            state: "rejected_before_dispatch",
            delivered: false,
            errorCategory: "dispatch_not_started",
            detail:
              "The original request did not reach dispatch and was not resent.",
          }
        : {
            state: "unknown",
            delivered: false,
            messageId: command.context.messageId,
            errorCategory: "previous_outcome_unknown",
            detail:
              "The original at-most-once dispatch has no recoverable outcome and was not resent.",
          };
    return this.#stageAndCompleteTest(command.id, result, correlationId);
  }

  async #stageAndCompleteTest(
    commandId: string,
    result: TestCommandResult,
    correlationId: string,
    body?: Uint8Array,
  ): Promise<TestCommandRecord> {
    const staged = await this.#ctx.repository.transaction(
      async (repository) => {
        await repository.acquireTimelineEvidenceLocks({
          commandIds: [commandId],
        });
        const current = await repository.lockTestCommand(commandId);
        if (current === undefined) {
          throw new ReferenceApiError(
            404,
            "TEST_COMMAND_NOT_FOUND",
            "The test command was not found.",
          );
        }
        if (current.evidenceState === "complete") {
          return current;
        }
        const next = await repository.stageTestCommandResult(
          commandId,
          this.#ctx.nowIso(),
          result,
        );
        if (next === undefined) {
          throw new Error(
            "The test command disappeared while staging a result.",
          );
        }
        await this.#ctx.outbox(
          {
            topic: "test.result_staged",
            aggregateType: "test_command",
            aggregateId: commandId,
            correlationId,
            payload: { state: result.state },
          },
          repository,
        );
        return next;
      },
    );
    if (staged.evidenceState === "complete") {
      return staged;
    }
    return this.#completeTestEvidence(commandId, correlationId, body);
  }

  async #completeTestEvidence(
    commandId: string,
    correlationId: string,
    suppliedBody?: Uint8Array,
  ): Promise<TestCommandRecord> {
    return this.#evidence.completeTestEvidence(
      commandId,
      correlationId,
      suppliedBody,
    );
  }
}
