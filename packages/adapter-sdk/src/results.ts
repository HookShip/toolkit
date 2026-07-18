// SPDX-License-Identifier: Apache-2.0

import type { AdapterOperation } from "./capabilities.js";
import type { MappingVersion, ProviderNativeRef } from "./model.js";

export type AdapterSideEffectState = "confirmed" | "none" | "possible";

export interface AdapterAcknowledgementMetadata {
  readonly commandFingerprint: string;
  readonly disposition: "completed" | "pending";
  readonly providerRequestId?: string;
}

export interface AdapterResultMetadata {
  readonly acknowledgement?: AdapterAcknowledgementMetadata;
  readonly mappingVersion?: MappingVersion;
  readonly providerRef?: ProviderNativeRef;
  readonly requestId?: string;
  readonly warnings?: readonly string[];
}

export interface AdapterOkResult<T> {
  readonly metadata?: AdapterResultMetadata;
  readonly ok: true;
  readonly sideEffects: AdapterSideEffectState;
  readonly status: "ok";
  readonly value: T;
}

export interface AdapterUnsupportedResult {
  readonly ok: false;
  readonly operation: AdapterOperation;
  readonly reason: string;
  readonly sideEffects: "none";
  readonly status: "unsupported";
}

export interface AdapterDegradedResult<T> {
  readonly metadata?: AdapterResultMetadata;
  readonly ok: false;
  readonly reason: string;
  readonly retryable: boolean;
  readonly sideEffects: AdapterSideEffectState;
  readonly status: "degraded";
  readonly value?: T;
}

export interface AdapterUnknownResult {
  readonly metadata?: AdapterResultMetadata;
  readonly ok: false;
  readonly reason: string;
  readonly retryable: boolean;
  readonly sideEffects: "none" | "possible";
  readonly status: "unknown";
}

export interface AdapterFailure {
  readonly code: string;
  readonly message: string;
  readonly retryAfterMilliseconds?: number;
  readonly retryable: boolean;
}

export interface AdapterFailureResult {
  readonly error: AdapterFailure;
  readonly metadata?: AdapterResultMetadata;
  readonly ok: false;
  readonly sideEffects: AdapterSideEffectState;
  readonly status: "failure";
}

export type AdapterResult<T> =
  | AdapterDegradedResult<T>
  | AdapterFailureResult
  | AdapterOkResult<T>
  | AdapterUnknownResult
  | AdapterUnsupportedResult;

function freezeMetadata(
  metadata: AdapterResultMetadata | undefined,
): AdapterResultMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...metadata,
    ...(metadata.acknowledgement === undefined
      ? {}
      : {
          acknowledgement: Object.freeze({
            ...metadata.acknowledgement,
          }),
        }),
    ...(metadata.warnings === undefined
      ? {}
      : { warnings: Object.freeze([...metadata.warnings]) }),
  });
}

export function okResult<T>(
  value: T,
  options: {
    readonly metadata?: AdapterResultMetadata;
    readonly sideEffects?: AdapterSideEffectState;
  } = {},
): AdapterOkResult<T> {
  const metadata = freezeMetadata(options.metadata);
  return Object.freeze({
    ok: true,
    status: "ok",
    value,
    sideEffects: options.sideEffects ?? "none",
    ...(metadata === undefined ? {} : { metadata }),
  });
}

export function unsupportedResult(
  operation: AdapterOperation,
  reason = "The adapter does not support this operation.",
): AdapterUnsupportedResult {
  return Object.freeze({
    ok: false,
    status: "unsupported",
    operation,
    reason,
    sideEffects: "none",
  });
}

export function degradedResult<T>(
  reason: string,
  options: {
    readonly metadata?: AdapterResultMetadata;
    readonly retryable?: boolean;
    readonly sideEffects?: AdapterSideEffectState;
    readonly value?: T;
  } = {},
): AdapterDegradedResult<T> {
  const metadata = freezeMetadata(options.metadata);
  return Object.freeze({
    ok: false,
    status: "degraded",
    reason,
    retryable: options.retryable ?? false,
    sideEffects: options.sideEffects ?? "none",
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

export function unknownResult(
  reason = "The provider outcome is unknown.",
  metadata?: AdapterResultMetadata,
  options: {
    readonly retryable?: boolean;
    readonly sideEffects?: "none" | "possible";
  } = {},
): AdapterUnknownResult {
  const frozenMetadata = freezeMetadata(metadata);
  return Object.freeze({
    ok: false,
    status: "unknown",
    reason,
    retryable: options.retryable ?? true,
    sideEffects: options.sideEffects ?? "possible",
    ...(frozenMetadata === undefined ? {} : { metadata: frozenMetadata }),
  });
}

export function failureResult(
  error: AdapterFailure,
  options: {
    readonly metadata?: AdapterResultMetadata;
    readonly sideEffects?: AdapterSideEffectState;
  } = {},
): AdapterFailureResult {
  const metadata = freezeMetadata(options.metadata);
  return Object.freeze({
    ok: false,
    status: "failure",
    error: Object.freeze({ ...error }),
    sideEffects: options.sideEffects ?? "none",
    ...(metadata === undefined ? {} : { metadata }),
  });
}
