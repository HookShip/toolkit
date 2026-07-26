// SPDX-License-Identifier: Apache-2.0

import {
  ADAPTER_OPERATIONS,
  createCapabilityDocument,
  createDeadlineSignal,
  failureResult,
  isDeadlineError,
  type Adapter,
  type AdapterCapabilityDeclaration,
  type AdapterCapabilityDocument,
  type AdapterCommand,
  type AdapterCommandResult,
  type AdapterOperation,
  type AdapterResultFor,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

import { type AcknowledgementReplayStore } from "./acknowledgement.js";
import {
  type GenericHttpAdapterConfig,
  type GenericHttpAuthConfig,
  type GenericHttpLimits,
  type GenericHttpRoute,
  type PreparedRequest,
} from "./adapter-types.js";
import { genericHttpPreflight } from "./adapter-preflight.js";
import {
  prepareGenericHttpRequest,
  validateMetadataCommand,
} from "./adapter-request.js";
import {
  awaitTransport,
  canRetryWithoutSideEffects,
  interpretGenericHttpResponse,
  isLocalTransportInputError,
  unknownForOperation,
} from "./adapter-response.js";
import {
  declarationStatus,
  operationSet,
  validateAuthenticationHeaderName,
  validateIdentifier,
  validateIdempotencyHeaderName,
  validateLimits,
  validateRoute,
} from "./adapter-validation.js";
import {
  DestinationResolutionError,
  UnsafeDestinationError,
  validateHttpDestinationSyntax,
  type DestinationPolicy,
} from "./destination.js";
import {
  DEFAULT_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS,
  MAX_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS,
  withIdempotencyStoreDeadline,
  type IdempotencyBeginResult,
  type IdempotencyStore,
} from "./idempotency.js";
import { nodeHttpTransport, type HttpTransport } from "./transport.js";
import { WireEncodingError } from "./wire.js";

export { DEFAULT_GENERIC_HTTP_LIMITS } from "./adapter-types.js";
export type {
  GenericHttpAdapterConfig,
  GenericHttpAuthConfig,
  GenericHttpLimits,
  GenericHttpRoute,
} from "./adapter-types.js";

type GenericHttpDeadline = ReturnType<typeof createDeadlineSignal>;

type PreparedRequestOutcome<TCommand extends AdapterCommand> =
  | {
      readonly ok: false;
      readonly result: AdapterResultFor<TCommand>;
    }
  | {
      readonly ok: true;
      readonly prepared: PreparedRequest;
    };

type IdempotencyReservationOutcome<TCommand extends AdapterCommand> =
  | {
      readonly ok: false;
      readonly result: AdapterResultFor<TCommand>;
    }
  | {
      readonly ok: true;
      readonly leaseToken: string;
      readonly leaseExpiresAt: number;
    };

export class GenericHttpAdapter implements Adapter {
  readonly capabilityDocument: AdapterCapabilityDocument;
  readonly #auth: GenericHttpAuthConfig | undefined;
  readonly #acknowledgementMaximumLifetime: number;
  readonly #acknowledgementReplayStore: AcknowledgementReplayStore | undefined;
  readonly #baseUrl: URL;
  readonly #clock: () => number;
  readonly #connectionId: string;
  readonly #destination: DestinationPolicy;
  readonly #envelopeMaximumLifetime: number;
  readonly #idempotencyHeaderName: string;
  readonly #idempotencyRetention: number;
  readonly #idempotencySafetyGrace: number;
  readonly #idempotencyStore: IdempotencyStore | undefined;
  readonly #limits: GenericHttpLimits;
  readonly #routes: Readonly<
    Partial<Record<AdapterOperation, GenericHttpRoute>>
  >;
  readonly #responseCredential: ScopedCredential | undefined;
  readonly #transport: HttpTransport;

  constructor(config: GenericHttpAdapterConfig) {
    validateIdentifier("connectionId", config.connectionId);
    this.#connectionId = config.connectionId;
    this.#limits = validateLimits(config.limits);
    this.#clock = config.clock ?? Date.now;
    this.#destination = Object.freeze({
      ...config.destination,
      maxUrlLength: this.#limits.maxUrlLength,
      ...(config.resolver === undefined ? {} : { resolver: config.resolver }),
    });
    this.#baseUrl = validateHttpDestinationSyntax(
      config.baseUrl,
      this.#destination,
    );
    this.#transport = config.transport ?? nodeHttpTransport;
    this.#acknowledgementReplayStore = config.acknowledgementReplayStore;
    this.#responseCredential = config.responseCredential;
    this.#auth =
      config.auth === undefined ? undefined : Object.freeze({ ...config.auth });
    this.#idempotencyStore = config.idempotencyStore;
    this.#idempotencyHeaderName =
      config.idempotencyHeaderName ?? "Idempotency-Key";
    validateIdempotencyHeaderName(this.#idempotencyHeaderName);
    if (config.auth?.headerName !== undefined) {
      validateAuthenticationHeaderName(
        config.auth.headerName,
        this.#idempotencyHeaderName,
      );
    }
    this.#idempotencyRetention =
      config.idempotencyRetentionMilliseconds ??
      DEFAULT_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS;
    this.#idempotencySafetyGrace =
      config.idempotencySafetyGraceMilliseconds ?? 30_000;
    this.#envelopeMaximumLifetime =
      config.envelopeMaximumLifetimeMilliseconds ?? 300_000;
    this.#acknowledgementMaximumLifetime =
      config.acknowledgementMaximumLifetimeMilliseconds ?? 300_000;
    if (
      !Number.isSafeInteger(this.#idempotencyRetention) ||
      this.#idempotencyRetention <= 0 ||
      this.#idempotencyRetention >
        MAX_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS ||
      !Number.isSafeInteger(this.#idempotencySafetyGrace) ||
      this.#idempotencySafetyGrace <= 0 ||
      !Number.isSafeInteger(this.#envelopeMaximumLifetime) ||
      this.#envelopeMaximumLifetime <= 0 ||
      !Number.isSafeInteger(this.#acknowledgementMaximumLifetime) ||
      this.#acknowledgementMaximumLifetime <= 0
    ) {
      throw new RangeError("Adapter timing limits must be positive integers.");
    }

    const routes: Partial<Record<AdapterOperation, GenericHttpRoute>> = {};
    const declarations: Partial<
      Record<AdapterOperation, AdapterCapabilityDeclaration>
    > = {};
    for (const operation of Object.keys(config.routes)) {
      if (!operationSet.has(operation)) {
        throw new RangeError(
          `${operation} is not an outbound adapter operation; inbound metadata must use MetadataIngestVerifier.`,
        );
      }
    }
    for (const operation of ADAPTER_OPERATIONS) {
      const route = config.routes[operation];
      const declaration = config.capabilities?.[operation];
      if (route !== undefined) {
        validateRoute(operation, route, this.#limits);
        if (
          Object.keys(route.headers ?? {}).some(
            (name) =>
              name.toLowerCase() === this.#idempotencyHeaderName.toLowerCase(),
          )
        ) {
          throw new RangeError(
            "A route header collides with the idempotency header.",
          );
        }
        routes[operation] = Object.freeze({
          ...route,
          ...(route.headers === undefined
            ? {}
            : { headers: Object.freeze({ ...route.headers }) }),
          ...(route.successStatusCodes === undefined
            ? {}
            : {
                successStatusCodes: Object.freeze([
                  ...route.successStatusCodes,
                ]),
              }),
        });
      }
      if (
        declaration !== undefined &&
        declarationStatus(declaration) !== "unsupported" &&
        route === undefined
      ) {
        throw new RangeError(
          `${operation} cannot be advertised without a route.`,
        );
      }
      declarations[operation] =
        declaration ??
        (route === undefined ? "unsupported" : (route.status ?? "supported"));
    }
    this.#routes = Object.freeze(routes);
    this.capabilityDocument = createCapabilityDocument({
      adapter: config.adapter,
      capabilities: declarations,
      ...(config.generatedAt === undefined
        ? {}
        : { generatedAt: config.generatedAt }),
    });
    const hasSideEffects = this.capabilityDocument.operations.some(
      (capability) =>
        capability.status !== "unsupported" && capability.sideEffecting,
    );
    if (hasSideEffects && this.#idempotencyStore === undefined) {
      throw new RangeError(
        "A durable IdempotencyStore is required for side-effecting operations.",
      );
    }
    const hasControlResponses = this.capabilityDocument.operations.some(
      (capability) =>
        capability.status !== "unsupported" &&
        capability.operation !== "metadata.poll" &&
        capability.operation !== "metadata.backfill",
    );
    if (
      hasControlResponses &&
      (this.#responseCredential === undefined ||
        this.#responseCredential.role !== "response" ||
        this.#acknowledgementReplayStore === undefined)
    ) {
      throw new RangeError(
        "Control operations require a distinct response-role credential and durable acknowledgement replay store.",
      );
    }
  }

  get capabilities(): AdapterCapabilityDocument {
    return this.capabilityDocument;
  }

  async execute<TCommand extends AdapterCommand>(
    command: TCommand,
  ): Promise<AdapterResultFor<TCommand>> {
    const preflight = await genericHttpPreflight(
      {
        baseUrl: this.#baseUrl,
        capabilityDocument: this.capabilityDocument,
        clock: this.#clock,
        connectionId: this.#connectionId,
        idempotencyStore: this.#idempotencyStore,
        responseCredential: this.#responseCredential,
        routes: this.#routes,
      },
      command,
    );
    if (!preflight.ok) {
      return preflight.result;
    }
    const { credential, capability, route, localFingerprint } = preflight;
    const deadline = createDeadlineSignal(
      command.context.deadline,
      command.context.signal,
      this.#clock,
    );
    let leaseToken: string | undefined;
    let leaseExpiresAt: number | undefined;
    let transportStarted = false;
    let prepared: PreparedRequest | undefined;
    try {
      const preparedOutcome = await this.#prepareCommandRequest(
        command,
        route,
        credential,
        deadline,
        localFingerprint,
      );
      if (!preparedOutcome.ok) {
        return preparedOutcome.result;
      }
      prepared = preparedOutcome.prepared;

      if (capability.sideEffecting) {
        const reservation = await this.#reserveIdempotency(
          command,
          prepared,
          deadline,
        );
        if (!reservation.ok) {
          return reservation.result;
        }
        leaseToken = reservation.leaseToken;
        leaseExpiresAt = reservation.leaseExpiresAt;
      }

      transportStarted = true;
      const result = await this.#dispatchPreparedCommand(
        command,
        route,
        prepared,
        capability.status,
        capability.sideEffecting,
        deadline,
        leaseToken,
        leaseExpiresAt,
      );
      return result as AdapterResultFor<TCommand>;
    } catch (error: unknown) {
      const result = await this.#handleExecuteError(
        error,
        command,
        capability.sideEffecting,
        deadline,
        transportStarted,
        prepared,
        leaseToken,
        leaseExpiresAt,
      );
      return result as AdapterResultFor<TCommand>;
    } finally {
      deadline.dispose();
    }
  }

  async #dispatchPreparedCommand(
    command: AdapterCommand,
    route: GenericHttpRoute,
    prepared: PreparedRequest,
    capabilityStatus: "degraded" | "supported",
    sideEffecting: boolean,
    deadline: GenericHttpDeadline,
    leaseToken: string | undefined,
    leaseExpiresAt: number | undefined,
  ): Promise<AdapterCommandResult> {
    const response = await awaitTransport(this.#transport, {
      ...prepared.request,
      headers: prepared.headers,
      signal: deadline.signal,
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
    });
    let result: AdapterCommandResult;
    if (deadline.signal.aborted) {
      result = unknownForOperation(
        command.kind,
        "The provider outcome is unknown because the command deadline elapsed.",
      );
    } else {
      result = await interpretGenericHttpResponse(
        {
          acknowledgementMaximumLifetime: this.#acknowledgementMaximumLifetime,
          acknowledgementReplayStore: this.#acknowledgementReplayStore,
          capabilityDocument: this.capabilityDocument,
          clock: this.#clock,
          connectionId: this.#connectionId,
          limits: this.#limits,
          responseCredential: this.#responseCredential,
        },
        command,
        route,
        prepared.commandEnvelope,
        response,
        capabilityStatus,
        sideEffecting,
        deadline.signal,
        command.context.deadline.at,
      );
    }
    if (leaseToken !== undefined) {
      if (canRetryWithoutSideEffects(result)) {
        const released = await this.#releaseIdempotency(
          command,
          prepared,
          leaseToken,
          leaseExpiresAt as number,
        );
        if (!released) {
          result = failureResult({
            code: "idempotency_store_unavailable",
            message:
              "The provider confirmed no side effects, but the durable idempotency reservation could not be released.",
            retryable: true,
          });
        }
      } else {
        result = await this.#completeIdempotency(
          command,
          prepared,
          result,
          leaseToken,
          leaseExpiresAt as number,
        );
      }
    }
    return result;
  }

  async #handleExecuteError(
    error: unknown,
    command: AdapterCommand,
    sideEffecting: boolean,
    deadline: GenericHttpDeadline,
    transportStarted: boolean,
    prepared: PreparedRequest | undefined,
    leaseToken: string | undefined,
    leaseExpiresAt: number | undefined,
  ): Promise<AdapterCommandResult> {
    let result: AdapterCommandResult;
    if (transportStarted && isLocalTransportInputError(error)) {
      transportStarted = false;
      result = failureResult({
        code: "headers.invalid_value",
        message:
          "The request headers were rejected locally before provider dispatch.",
        retryable: false,
      });
    } else if (transportStarted && sideEffecting) {
      result = unknownForOperation(
        command.kind,
        deadline.didTimeout()
          ? "The provider outcome is unknown because the command deadline elapsed."
          : "The provider outcome is unknown because transport failed after dispatch.",
      );
    } else if (!transportStarted) {
      result = this.#preflightFailure(
        error,
        deadline.didTimeout(),
        command.context.signal?.aborted === true,
      );
    } else {
      const controlledCode =
        error instanceof WireEncodingError ||
        error instanceof UnsafeDestinationError
          ? error.code
          : undefined;
      result = failureResult({
        code:
          controlledCode ??
          (deadline.didTimeout() ? "deadline_exceeded" : "transport_error"),
        message:
          error instanceof Error ? error.message : "The provider read failed.",
        retryable: controlledCode === undefined,
      });
    }
    if (leaseToken !== undefined && prepared !== undefined) {
      if (transportStarted) {
        result = await this.#completeIdempotency(
          command,
          prepared,
          result,
          leaseToken,
          leaseExpiresAt as number,
        );
      } else {
        await this.#releaseIdempotency(
          command,
          prepared,
          leaseToken,
          leaseExpiresAt as number,
        );
      }
    }
    return result;
  }

  async #prepareCommandRequest<TCommand extends AdapterCommand>(
    command: TCommand,
    route: GenericHttpRoute,
    credential: ScopedCredential,
    deadline: GenericHttpDeadline,
    localFingerprint: string | undefined,
  ): Promise<PreparedRequestOutcome<TCommand>> {
    if (deadline.signal.aborted) {
      return {
        ok: false,
        result: failureResult({
          code: deadline.didTimeout() ? "deadline_exceeded" : "cancelled",
          message: "The command expired before dispatch.",
          retryable: true,
        }) as AdapterResultFor<TCommand>,
      };
    }
    validateMetadataCommand(command);
    const prepared = await prepareGenericHttpRequest(
      {
        auth: this.#auth,
        baseUrl: this.#baseUrl,
        capabilityDocument: this.capabilityDocument,
        clock: this.#clock,
        connectionId: this.#connectionId,
        destination: this.#destination,
        envelopeMaximumLifetime: this.#envelopeMaximumLifetime,
        idempotencyHeaderName: this.#idempotencyHeaderName,
        limits: this.#limits,
      },
      command,
      route,
      credential,
      deadline.signal,
    );
    if (
      localFingerprint !== undefined &&
      prepared.commandEnvelope.commandFingerprint !== localFingerprint
    ) {
      throw new WireEncodingError(
        "command.fingerprint_mismatch",
        "The authenticated command envelope fingerprint changed during preparation.",
      );
    }
    if (deadline.signal.aborted) {
      return {
        ok: false,
        result: failureResult({
          code: deadline.didTimeout() ? "deadline_exceeded" : "cancelled",
          message: "The command expired before dispatch.",
          retryable: true,
        }) as AdapterResultFor<TCommand>,
      };
    }
    return { ok: true, prepared };
  }

  async #reserveIdempotency<TCommand extends AdapterCommand>(
    command: TCommand,
    prepared: PreparedRequest,
    deadline: GenericHttpDeadline,
  ): Promise<IdempotencyReservationOutcome<TCommand>> {
    const store = this.#idempotencyStore as IdempotencyStore;
    let decision: IdempotencyBeginResult;
    let leaseExpiresAt: number | undefined;
    try {
      leaseExpiresAt =
        command.context.deadline.at + this.#idempotencySafetyGrace;
      if (!Number.isSafeInteger(leaseExpiresAt)) {
        throw new RangeError("The idempotency lease expiry is invalid.");
      }
      decision = await withIdempotencyStoreDeadline(
        (signal) =>
          store.begin({
            commandDeadline: command.context.deadline.at,
            connectionId: this.#connectionId,
            idempotencyKey: command.context.idempotency.key,
            commandFingerprint: (prepared as PreparedRequest).commandEnvelope
              .commandFingerprint,
            operation: command.kind,
            leaseExpiresAt: leaseExpiresAt as number,
            resultExpiresAt: Math.max(
              this.#clock() + this.#idempotencyRetention,
              leaseExpiresAt as number,
            ),
            safetyGraceMilliseconds: this.#idempotencySafetyGrace,
            deadlineAt: command.context.deadline.at,
            signal,
          }),
        command.context.deadline.at,
        deadline.signal,
        this.#clock,
      );
    } catch (error: unknown) {
      return {
        ok: false,
        result: failureResult({
          code: isDeadlineError(error)
            ? "deadline_exceeded"
            : "idempotency_store_unavailable",
          message: isDeadlineError(error)
            ? "The command deadline expired during idempotency reservation."
            : "The durable idempotency store is unavailable; the command was not dispatched.",
          retryable: true,
        }) as AdapterResultFor<TCommand>,
      };
    }
    if (decision.status === "replay") {
      return {
        ok: false,
        result: decision.result as AdapterResultFor<TCommand>,
      };
    }
    if (decision.status === "conflict") {
      return {
        ok: false,
        result: failureResult({
          code: "idempotency_conflict",
          message: `The key is already bound to ${decision.operation}.`,
          retryable: false,
        }) as AdapterResultFor<TCommand>,
      };
    }
    if (decision.status === "capacity") {
      return {
        ok: false,
        result: failureResult({
          code: "idempotency_store_capacity",
          message: "The idempotency store refused to evict protected records.",
          retryable: true,
        }) as AdapterResultFor<TCommand>,
      };
    }
    if (decision.status === "in_progress") {
      return {
        ok: false,
        result: unknownForOperation(
          command.kind,
          "An identical command is already in progress.",
        ) as AdapterResultFor<TCommand>,
      };
    }
    const leaseToken = decision.leaseToken;
    if (deadline.signal.aborted) {
      const released = await this.#releaseIdempotency(
        command,
        prepared,
        leaseToken,
        leaseExpiresAt as number,
      );
      if (!released) {
        return {
          ok: false,
          result: failureResult({
            code: "idempotency_store_unavailable",
            message:
              "The expired command was not dispatched, but its reservation could not be released.",
            retryable: true,
          }) as AdapterResultFor<TCommand>,
        };
      }
      return {
        ok: false,
        result: failureResult({
          code: "deadline_exceeded",
          message: "The command expired before provider dispatch.",
          retryable: true,
        }) as AdapterResultFor<TCommand>,
      };
    }
    return {
      ok: true,
      leaseToken,
      leaseExpiresAt: leaseExpiresAt as number,
    };
  }

  #preflightFailure(
    error: unknown,
    deadlineExpired = false,
    parentAborted = false,
  ): AdapterCommandResult {
    if (error instanceof DestinationResolutionError) {
      return failureResult({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    }
    if (deadlineExpired) {
      return failureResult({
        code: "deadline_exceeded",
        message: "The command deadline expired before dispatch.",
        retryable: true,
      });
    }
    if (
      parentAborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return failureResult({
        code: "cancelled",
        message: "The command was cancelled before dispatch.",
        retryable: true,
      });
    }
    const code =
      error instanceof UnsafeDestinationError ||
      error instanceof WireEncodingError
        ? error.code
        : "invalid_command";
    return failureResult({
      code,
      message:
        error instanceof Error
          ? error.message
          : "The command failed preflight validation.",
      retryable: false,
    });
  }

  async #completeIdempotency(
    command: AdapterCommand,
    prepared: PreparedRequest,
    result: AdapterCommandResult,
    leaseToken: string,
    leaseExpiresAt: number,
  ): Promise<AdapterCommandResult> {
    try {
      await withIdempotencyStoreDeadline(
        (signal) =>
          (this.#idempotencyStore as IdempotencyStore).complete({
            connectionId: this.#connectionId,
            idempotencyKey: command.context.idempotency.key,
            commandFingerprint: prepared.commandEnvelope.commandFingerprint,
            leaseToken,
            result,
            deadlineAt: leaseExpiresAt,
            signal,
          }),
        leaseExpiresAt,
        undefined,
        this.#clock,
      );
      return result;
    } catch {
      return unknownForOperation(
        command.kind,
        "The provider responded, but the durable idempotency result could not be persisted.",
      );
    }
  }

  async #releaseIdempotency(
    command: AdapterCommand,
    prepared: PreparedRequest,
    leaseToken: string,
    leaseExpiresAt: number,
  ): Promise<boolean> {
    try {
      await withIdempotencyStoreDeadline(
        (signal) =>
          (this.#idempotencyStore as IdempotencyStore).release({
            connectionId: this.#connectionId,
            idempotencyKey: command.context.idempotency.key,
            commandFingerprint: prepared.commandEnvelope.commandFingerprint,
            leaseToken,
            deadlineAt: leaseExpiresAt,
            signal,
          }),
        leaseExpiresAt,
        undefined,
        this.#clock,
      );
      return true;
    } catch {
      return false;
    }
  }
}

export function createGenericHttpAdapter(
  config: GenericHttpAdapterConfig,
): GenericHttpAdapter {
  return new GenericHttpAdapter(config);
}
