// SPDX-License-Identifier: Apache-2.0

import type {
  AdapterCapability,
  AdapterCapabilityDeclaration,
  AdapterCommand,
  AdapterIdentity,
  AdapterOperation,
  AdapterResultFor,
  AuthenticatedCommandEnvelope,
  MappingVersion,
  ScopedCredential,
} from "@webhook-portal/adapter-sdk";

import type { AcknowledgementReplayStore } from "./acknowledgement.js";
import type { DestinationPolicy, HostResolver } from "./destination.js";
import type { IdempotencyStore } from "./idempotency.js";
import type {
  HttpMethod,
  HttpTransport,
  HttpTransportRequest,
} from "./transport.js";

export interface GenericHttpRoute {
  readonly degradedReason?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly mappingVersion?: MappingVersion;
  readonly method: HttpMethod;
  readonly path: string;
  readonly status?: "degraded" | "supported";
  readonly successStatusCodes?: readonly number[];
}

export interface GenericHttpLimits {
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxMetadataRecords: number;
  readonly maxRequestBodyBytes: number;
  readonly maxRequestHeaderBytes: number;
  readonly maxRequestHeaders: number;
  readonly maxResponseBodyBytes: number;
  readonly maxResponseHeaderBytes: number;
  readonly maxResponseHeaders: number;
  readonly maxUrlLength: number;
}

export const DEFAULT_GENERIC_HTTP_LIMITS = Object.freeze({
  maxJsonDepth: 32,
  maxJsonNodes: 50_000,
  maxMetadataRecords: 1_000,
  maxRequestBodyBytes: 262_144,
  maxRequestHeaderBytes: 32_768,
  maxRequestHeaders: 64,
  maxResponseBodyBytes: 1_048_576,
  maxResponseHeaderBytes: 32_768,
  maxResponseHeaders: 128,
  maxUrlLength: 4_096,
}) satisfies GenericHttpLimits;

export interface GenericHttpAuthConfig {
  readonly headerName?: string;
  readonly prefix?: string;
}

export interface GenericHttpAdapterConfig {
  readonly acknowledgementMaximumLifetimeMilliseconds?: number;
  readonly acknowledgementReplayStore?: AcknowledgementReplayStore;
  readonly adapter: AdapterIdentity;
  readonly auth?: GenericHttpAuthConfig;
  readonly baseUrl: string;
  readonly capabilities?: Partial<
    Record<AdapterOperation, AdapterCapabilityDeclaration>
  >;
  readonly clock?: () => number;
  readonly connectionId: string;
  readonly destination?: DestinationPolicy;
  readonly envelopeMaximumLifetimeMilliseconds?: number;
  readonly generatedAt?: string;
  readonly idempotencyHeaderName?: string;
  readonly idempotencyRetentionMilliseconds?: number;
  readonly idempotencySafetyGraceMilliseconds?: number;
  readonly idempotencyStore?: IdempotencyStore;
  readonly limits?: Partial<GenericHttpLimits>;
  readonly resolver?: HostResolver;
  readonly responseCredential?: ScopedCredential;
  readonly routes: Partial<Record<AdapterOperation, GenericHttpRoute>>;
  readonly transport?: HttpTransport;
}

export interface PreparedRequest {
  readonly body?: Uint8Array;
  readonly commandEnvelope: AuthenticatedCommandEnvelope;
  readonly headers: Readonly<Record<string, string>>;
  readonly request: Omit<HttpTransportRequest, "body" | "headers" | "signal">;
  readonly route: GenericHttpRoute;
}

/**
 * Result of the preflight phase: either a terminal validation/replay result to
 * return immediately, or the validated context the dispatch phase needs.
 */
export type PreflightOutcome<TCommand extends AdapterCommand> =
  | { readonly ok: false; readonly result: AdapterResultFor<TCommand> }
  | {
      readonly ok: true;
      readonly credential: ScopedCredential;
      readonly capability: AdapterCapability & {
        readonly status: "degraded" | "supported";
      };
      readonly route: GenericHttpRoute;
      readonly localFingerprint: string | undefined;
    };
