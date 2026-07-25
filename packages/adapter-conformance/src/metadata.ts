// SPDX-License-Identifier: Apache-2.0

import {
  CANONICAL_METADATA_SCHEMA_VERSION,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  canonicalizeMetadataRecord,
  type CanonicalDeliveryAttemptMetadata,
  type MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";

function metadataInput(
  overrides: Partial<MetadataDeliveryAttemptInput> = {},
): MetadataDeliveryAttemptInput {
  return {
    kind: "delivery_attempt",
    schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
    eventId: "event-conformance",
    deliveryId: "delivery-conformance",
    endpointId: "endpoint-conformance",
    eventVersion: {
      eventType: "invoice.paid",
      version: "2026-07-01",
      schemaChecksum: "a".repeat(64),
    },
    attempt: 1,
    sequence: 1,
    status: "attempting",
    occurredAt: "2026-07-01T00:00:00.000Z",
    mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
    ...overrides,
  };
}

export function defaultMetadata(
  overrides: Partial<MetadataDeliveryAttemptInput> = {},
): CanonicalDeliveryAttemptMetadata {
  return canonicalizeMetadataRecord(metadataInput(overrides), {
    tenantId: "tenant-conformance",
    environment: "test",
    connectionId: "connection-conformance",
    adapterId: "adapter-conformance",
  });
}

export function deriveMetadata(
  record: CanonicalDeliveryAttemptMetadata,
  overrides: Partial<MetadataDeliveryAttemptInput> = {},
  identityOverrides: Partial<{
    readonly adapterId: string;
    readonly connectionId: string;
    readonly environment: string;
    readonly tenantId: string;
  }> = {},
): CanonicalDeliveryAttemptMetadata {
  const {
    adapterId,
    connectionId,
    dedupeKey: _dedupeKey,
    environment,
    tenantId,
    ...input
  } = record;
  void _dedupeKey;
  return canonicalizeMetadataRecord(
    {
      ...input,
      ...overrides,
      eventVersion: {
        ...input.eventVersion,
        ...overrides.eventVersion,
      },
      mappingVersion: {
        ...input.mappingVersion,
        ...overrides.mappingVersion,
      },
    },
    {
      tenantId: identityOverrides.tenantId ?? tenantId,
      environment: identityOverrides.environment ?? environment,
      connectionId: identityOverrides.connectionId ?? connectionId,
      adapterId: identityOverrides.adapterId ?? adapterId,
    },
  );
}
