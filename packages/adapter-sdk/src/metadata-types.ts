// SPDX-License-Identifier: Apache-2.0

import type { MappingVersion, ProviderNativeRef } from "./model.js";

export const CANONICAL_METADATA_SCHEMA_VERSION = "2026-07-01" as const;
export const METADATA_INGEST_SCHEMA_VERSION = "2026-07-01" as const;
export const METADATA_INGEST_SIGNATURE_ALGORITHM = "hmac-sha256" as const;

export type DeliveryAttemptStatus =
  | "attempting"
  | "cancelled"
  | "delivered"
  | "exhausted"
  | "failed"
  | "pending"
  | "retry_scheduled"
  | "unknown";

export interface EventVersionProvenance {
  readonly eventType: string;
  readonly schemaChecksum: string;
  readonly version: string;
}

export interface MetadataDeliveryAttemptInput {
  readonly attempt: number;
  readonly deliveryId: string;
  readonly durationMilliseconds?: number;
  readonly endpointId: string;
  readonly errorCode?: string;
  readonly eventId: string;
  readonly eventVersion: EventVersionProvenance;
  readonly kind: "delivery_attempt";
  readonly mappingVersion: MappingVersion;
  readonly nextAttemptAt?: string;
  readonly occurredAt: string;
  readonly providerAttemptId?: string;
  readonly providerRef?: ProviderNativeRef;
  readonly responseStatusCode?: number;
  readonly retryable?: boolean;
  readonly schemaVersion: typeof CANONICAL_METADATA_SCHEMA_VERSION;
  readonly sequence: number;
  readonly sourceDedupeKey?: string;
  readonly status: DeliveryAttemptStatus;
  readonly subscriptionId?: string;
  readonly traceId?: string;
}

export interface MetadataIdentity {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly environment: string;
  readonly tenantId: string;
}

export interface CanonicalDeliveryAttemptMetadata
  extends MetadataDeliveryAttemptInput, MetadataIdentity {
  readonly dedupeKey: string;
}

export type CanonicalMetadataRecord = CanonicalDeliveryAttemptMetadata;

export const METADATA_DELIVERY_INPUT_FIELDS = [
  "attempt",
  "deliveryId",
  "durationMilliseconds",
  "endpointId",
  "errorCode",
  "eventId",
  "eventVersion",
  "kind",
  "mappingVersion",
  "nextAttemptAt",
  "occurredAt",
  "providerAttemptId",
  "providerRef",
  "responseStatusCode",
  "retryable",
  "schemaVersion",
  "sequence",
  "sourceDedupeKey",
  "status",
  "subscriptionId",
  "traceId",
] as const;

export const CANONICAL_METADATA_FIELDS = [
  ...METADATA_DELIVERY_INPUT_FIELDS,
  "adapterId",
  "connectionId",
  "dedupeKey",
  "environment",
  "tenantId",
] as const;

export type CanonicalMetadataField = (typeof CANONICAL_METADATA_FIELDS)[number];

export interface MetadataValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type MetadataInputValidationResult =
  | {
      readonly ok: true;
      readonly value: MetadataDeliveryAttemptInput;
    }
  | {
      readonly issues: readonly MetadataValidationIssue[];
      readonly ok: false;
    };

export type MetadataValidationResult =
  | {
      readonly ok: true;
      readonly value: CanonicalMetadataRecord;
    }
  | {
      readonly issues: readonly MetadataValidationIssue[];
      readonly ok: false;
    };
