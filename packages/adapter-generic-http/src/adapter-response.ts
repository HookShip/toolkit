// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_ADAPTER_MAPPING_VERSION,
  canonicalizeMetadataRecord,
  degradedResult,
  failureResult,
  isSideEffectingOperation,
  okResult,
  reduceDeliveryAttempt,
  unknownResult,
  validateMetadataDeliveryAttemptInput,
  type AdapterCapabilityDocument,
  type AdapterCommand,
  type AdapterCommandResult,
  type AdapterOperation,
  type AuthenticatedCommandEnvelope,
  type CanonicalMetadataRecord,
  type DeliveryAttemptReduction,
  type ProviderNativeRef,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

import {
  verifyProviderAcknowledgement,
  type AcknowledgementReplayStore,
  type AuthenticatedProviderAcknowledgement,
} from "./acknowledgement.js";
import {
  type GenericHttpLimits,
  type GenericHttpRoute,
} from "./adapter-types.js";
import { expectedResourceId, responseHeaders } from "./adapter-request.js";
import { wireLimits } from "./adapter-validation.js";
import {
  HttpTransportInputError,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from "./transport.js";
import { WireEncodingError, parseBoundedJson } from "./wire.js";

function statusIsSuccessful(status: number, route: GenericHttpRoute): boolean {
  return (
    route.successStatusCodes?.includes(status) ??
    (status >= 200 && status <= 299)
  );
}

function retryableUnknown(operation: AdapterOperation): boolean {
  return operation !== "send_test";
}

export function unknownForOperation(
  operation: AdapterOperation,
  reason: string,
): AdapterCommandResult {
  return unknownResult(reason, undefined, {
    retryable: retryableUnknown(operation),
    sideEffects: isSideEffectingOperation(operation) ? "possible" : "none",
  });
}

export function failureForStatus(
  status: number,
  operation: AdapterOperation,
  sideEffecting: boolean,
): AdapterCommandResult {
  if (sideEffecting && (status === 408 || status === 504 || status >= 500)) {
    return unknownForOperation(
      operation,
      "The provider returned an ambiguous error after receiving the command.",
    );
  }
  const [code, retryable] =
    status === 401 || status === 403
      ? (["authentication_failed", false] as const)
      : status === 404
        ? (["not_found", false] as const)
        : status === 409
          ? (["conflict", false] as const)
          : status === 422
            ? (["invalid_request", false] as const)
            : status === 429
              ? (["rate_limited", true] as const)
              : status >= 500
                ? (["provider_unavailable", true] as const)
                : (["http_error", false] as const);
  return failureResult({
    code,
    message: `The provider returned HTTP ${status}.`,
    retryable,
  });
}

export function canRetryWithoutSideEffects(
  result: AdapterCommandResult,
): boolean {
  if (result.sideEffects !== "none") {
    return false;
  }
  if (result.status === "failure") {
    return result.error.retryable;
  }
  if (result.status === "degraded" || result.status === "unknown") {
    return result.retryable;
  }
  return false;
}

export function metadataResult(
  parsed: unknown,
  command: Extract<
    AdapterCommand,
    { readonly kind: "metadata.backfill" | "metadata.poll" }
  >,
  adapterId: string,
  maximumRecords: number,
): {
  readonly cursor?: string;
  readonly hasMore: boolean;
  readonly records: readonly CanonicalMetadataRecord[];
  readonly reductions: readonly DeliveryAttemptReduction[];
} {
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    if (parsed === undefined) {
      return { records: [], reductions: [], hasMore: false };
    }
    throw new WireEncodingError(
      "metadata.invalid_response",
      "The metadata response must be a closed object.",
    );
  }
  const object = parsed as Readonly<Record<string, unknown>>;
  const allowed = new Set(["cursor", "hasMore", "records"]);
  if (!Object.keys(object).every((key) => allowed.has(key))) {
    throw new WireEncodingError(
      "metadata.unrestricted_response",
      "The metadata response contains a non-allowlisted field.",
    );
  }
  if (
    !Array.isArray(object["records"]) ||
    object["records"].length > maximumRecords ||
    (object["cursor"] !== undefined && typeof object["cursor"] !== "string") ||
    (object["hasMore"] !== undefined && typeof object["hasMore"] !== "boolean")
  ) {
    throw new WireEncodingError(
      "metadata.invalid_response",
      "The metadata response fields are invalid.",
    );
  }
  const identity = {
    tenantId: command.context.tenant.id,
    environment: command.context.environment.id,
    connectionId: command.context.connection.id,
    adapterId,
  };
  const records: CanonicalMetadataRecord[] = [];
  const seen = new Set<string>();
  const reductions = new Map<string, DeliveryAttemptReduction>();
  for (const candidate of object["records"]) {
    const validation = validateMetadataDeliveryAttemptInput(candidate);
    if (!validation.ok) {
      throw new WireEncodingError(
        "metadata.invalid_record",
        validation.issues[0]?.message ?? "The metadata record is invalid.",
      );
    }
    const record = canonicalizeMetadataRecord(validation.value, identity);
    if (seen.has(record.dedupeKey)) {
      continue;
    }
    seen.add(record.dedupeKey);
    records.push(record);
    const key = `${record.tenantId}\u0000${record.environment}\u0000${record.connectionId}\u0000${record.adapterId}\u0000${record.deliveryId}`;
    reductions.set(key, reduceDeliveryAttempt(reductions.get(key), record));
  }
  return {
    records: Object.freeze(records),
    reductions: Object.freeze([...reductions.values()]),
    hasMore: (object["hasMore"] as boolean | undefined) ?? false,
    ...(object["cursor"] === undefined
      ? {}
      : { cursor: object["cursor"] as string }),
  };
}

function providerRef(
  acknowledgement: AuthenticatedProviderAcknowledgement,
  adapterId: string,
): ProviderNativeRef | undefined {
  return acknowledgement.result.kind !== "resource"
    ? undefined
    : Object.freeze({
        provider: adapterId,
        resourceType: acknowledgement.result.resource.type,
        id: acknowledgement.result.resource.id,
      });
}

function acknowledgementValue(
  command: AdapterCommand,
  acknowledgement: AuthenticatedProviderAcknowledgement,
  adapterId: string,
): unknown {
  const nativeRef = providerRef(acknowledgement, adapterId);
  const pending = acknowledgement.disposition === "pending";
  const mappingVersion = acknowledgement.mappingVersion;
  const resource =
    acknowledgement.result.kind === "resource"
      ? acknowledgement.result.resource
      : undefined;
  switch (command.kind) {
    case "endpoint.create":
    case "endpoint.pause":
    case "endpoint.read":
    case "endpoint.resume":
    case "endpoint.update":
      return {
        endpoint: {
          id:
            command.kind === "endpoint.create"
              ? command.input.endpoint.id
              : command.input.endpoint.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
        },
      };
    case "endpoint.delete":
      return {
        deleted: !pending,
        endpoint: {
          id: command.input.endpoint.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
        },
      };
    case "endpoint.verify":
      return {
        verified:
          pending || acknowledgement.result.kind !== "resource"
            ? false
            : (acknowledgement.result.verified ?? false),
        endpoint: {
          id: command.input.endpoint.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
        },
      };
    case "subscription.pause":
    case "subscription.read":
    case "subscription.replace":
    case "subscription.resume":
      return {
        subscription: {
          id:
            command.kind === "subscription.replace"
              ? (command.input.subscription?.id ?? command.input.definition.id)
              : command.input.subscription.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
        },
      };
    case "secret.create":
    case "secret.revoke":
    case "secret.rotate_with_overlap":
      return {
        secret: {
          id:
            command.kind === "secret.create"
              ? resource?.id
              : command.input.secret.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
          ...(command.kind === "secret.rotate_with_overlap"
            ? { overlapUntil: command.input.overlapUntil }
            : {}),
        },
      };
    case "send_test":
      return {
        accepted:
          acknowledgement.result.kind === "test_dispatch" &&
          acknowledgement.result.accepted,
        state: pending ? "pending" : "accepted",
        ...(acknowledgement.result.kind !== "test_dispatch" ||
        acknowledgement.result.deliveryId === undefined
          ? {}
          : { deliveryId: acknowledgement.result.deliveryId }),
      };
    case "request_replay":
      return {
        accepted:
          acknowledgement.result.kind === "replay" &&
          acknowledgement.result.accepted,
        state: pending ? "pending" : "accepted",
        ...(acknowledgement.result.kind !== "replay" ||
        acknowledgement.result.replayId === undefined
          ? {}
          : { replayId: acknowledgement.result.replayId }),
      };
    case "metadata.poll":
    case "metadata.backfill":
      throw new Error(
        "Metadata operations do not use control acknowledgements.",
      );
  }
}

export async function awaitTransport(
  transport: HttpTransport,
  request: HttpTransportRequest,
): Promise<HttpTransportResponse> {
  const operation = transport(request);
  return new Promise<HttpTransportResponse>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        request.signal.removeEventListener("abort", abort);
        callback();
      }
    };
    const abort = (): void => {
      finish(() =>
        reject(
          request.signal.reason instanceof Error
            ? request.signal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        ),
      );
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return;
    }
    void operation.then(
      (response) => finish(() => resolve(response)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error("HTTP transport failed."),
          ),
        ),
    );
  });
}

export function isLocalTransportInputError(error: unknown): boolean {
  if (error instanceof HttpTransportInputError) {
    return true;
  }
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return (
    code === "ERR_INVALID_CHAR" ||
    code === "ERR_HTTP_INVALID_HEADER_VALUE" ||
    code === "ERR_INVALID_HTTP_TOKEN"
  );
}

interface GenericHttpInterpretContext {
  readonly acknowledgementMaximumLifetime: number;
  readonly acknowledgementReplayStore: AcknowledgementReplayStore | undefined;
  readonly capabilityDocument: AdapterCapabilityDocument;
  readonly clock: () => number;
  readonly connectionId: string;
  readonly limits: GenericHttpLimits;
  readonly responseCredential: ScopedCredential | undefined;
}
export async function interpretGenericHttpResponse(
  context: GenericHttpInterpretContext,
  command: AdapterCommand,
  route: GenericHttpRoute,
  envelope: AuthenticatedCommandEnvelope,
  response: HttpTransportResponse,
  capabilityStatus: "degraded" | "supported",
  sideEffecting: boolean,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<AdapterCommandResult> {
  if (
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  ) {
    throw new WireEncodingError(
      "response.invalid_status",
      "The HTTP transport returned an invalid status code.",
    );
  }
  responseHeaders(response, context.limits);
  if (!statusIsSuccessful(response.status, route)) {
    return failureForStatus(response.status, command.kind, sideEffecting);
  }
  const parsed = parseBoundedJson(
    response.body,
    wireLimits(context.limits, true),
  );

  if (
    command.kind === "metadata.poll" ||
    command.kind === "metadata.backfill"
  ) {
    if (response.status === 202) {
      return degradedResult("The metadata query is pending.", {
        retryable: true,
        sideEffects: "none",
      }) as AdapterCommandResult;
    }
    const value = metadataResult(
      parsed,
      command,
      context.capabilityDocument.adapter.id,
      context.limits.maxMetadataRecords,
    );
    return capabilityStatus === "degraded"
      ? (degradedResult(route.degradedReason ?? "The route is degraded.", {
          value,
          retryable: false,
          sideEffects: "none",
        }) as AdapterCommandResult)
      : (okResult(value, { sideEffects: "none" }) as AdapterCommandResult);
  }

  if (response.status === 204 || parsed === undefined) {
    return sideEffecting
      ? unknownForOperation(
          command.kind,
          "The provider returned an empty acknowledgement; no state was confirmed.",
        )
      : failureResult({
          code: "acknowledgement.missing",
          message: "The provider did not return a state acknowledgement.",
          retryable: true,
        });
  }
  const mappingVersion =
    route.mappingVersion ?? DEFAULT_ADAPTER_MAPPING_VERSION;
  const boundResourceId = expectedResourceId(command);
  const validation = await verifyProviderAcknowledgement(
    parsed,
    {
      adapterId: context.capabilityDocument.adapter.id,
      operation: command.kind,
      connectionId: context.connectionId,
      tenantId: command.context.tenant.id,
      environment: command.context.environment.id,
      requestNonce: envelope.nonce,
      idempotencyKey: command.context.idempotency.key,
      commandFingerprint: envelope.commandFingerprint,
      mappingVersion,
      ...(boundResourceId === undefined
        ? {}
        : { expectedResourceId: boundResourceId }),
    },
    context.responseCredential as ScopedCredential,
    context.acknowledgementReplayStore as AcknowledgementReplayStore,
    {
      now: context.clock(),
      maximumLifetimeMilliseconds: context.acknowledgementMaximumLifetime,
      signal,
      deadlineAt,
    },
  );
  if (!validation.ok) {
    return sideEffecting
      ? unknownForOperation(command.kind, validation.message)
      : failureResult({
          code: validation.code,
          message: validation.message,
          retryable: false,
        });
  }
  const acknowledgement = validation.acknowledgement;
  if (
    (response.status === 202 && acknowledgement.disposition !== "pending") ||
    (response.status !== 202 &&
      acknowledgement.disposition === "pending" &&
      response.status === 204)
  ) {
    return sideEffecting
      ? unknownForOperation(
          command.kind,
          "The HTTP status contradicts the provider acknowledgement.",
        )
      : failureResult({
          code: "acknowledgement.status_contradiction",
          message: "The HTTP status contradicts the provider acknowledgement.",
          retryable: false,
        });
  }
  const value = acknowledgementValue(
    command,
    acknowledgement,
    context.capabilityDocument.adapter.id,
  );
  const acknowledgedProviderRef = providerRef(
    acknowledgement,
    context.capabilityDocument.adapter.id,
  );
  const resultMetadata = {
    mappingVersion,
    ...(acknowledgedProviderRef === undefined
      ? {}
      : { providerRef: acknowledgedProviderRef }),
    acknowledgement: {
      disposition: acknowledgement.disposition,
      commandFingerprint: acknowledgement.commandFingerprint,
    },
  };
  if (acknowledgement.disposition === "pending") {
    return degradedResult("The provider accepted the command asynchronously.", {
      value,
      metadata: resultMetadata,
      retryable: false,
      sideEffects: sideEffecting ? "possible" : "none",
    }) as AdapterCommandResult;
  }
  return capabilityStatus === "degraded"
    ? (degradedResult(route.degradedReason ?? "The route is degraded.", {
        value,
        metadata: resultMetadata,
        retryable: false,
        sideEffects: sideEffecting ? "confirmed" : "none",
      }) as AdapterCommandResult)
    : (okResult(value, {
        metadata: resultMetadata,
        sideEffects: sideEffecting ? "confirmed" : "none",
      }) as AdapterCommandResult);
}
