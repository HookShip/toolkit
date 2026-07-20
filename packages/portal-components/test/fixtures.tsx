// SPDX-License-Identifier: Apache-2.0

import type {
  BackendCapabilitySummary,
  BackendSelectionIssue,
  DeliveryAttempt,
  EndpointSummary,
  EventSummary,
  SchemaProperty,
} from "../src/index.js";

export const eventFixtures: readonly EventSummary[] = [
  {
    category: "Orders",
    description: "Emitted after an order clears fulfillment.",
    href: "/events/order.delivered",
    id: "evt-order-delivered",
    name: "Order delivered",
    version: "2026-07-01",
  },
  {
    category: "Accounts",
    deprecated: true,
    description: "Legacy account activation signal.",
    href: "/events/account.activated",
    id: "evt-account-activated",
    name: "Account activated",
    version: "2024-01-01",
  },
];

export const schemaFixtures: readonly SchemaProperty[] = [
  {
    description: "Canonical order identifier.",
    example: "ord_01J2Y8",
    name: "data.order_id",
    required: true,
    type: "string",
  },
  {
    description: "Delivery completion time.",
    example: "2026-07-17T01:16:42Z",
    name: "data.delivered_at",
    type: "date-time",
  },
];

export const endpointFixtures: readonly EndpointSummary[] = [
  {
    eventCount: 4,
    href: "/endpoints/primary",
    id: "ep-primary",
    name: "Production ingestion",
    status: "active",
    updatedAt: "2026-07-17T01:20:00Z",
    updatedAtLabel: "5 minutes ago",
    url: "https://hooks.example.com/webhooks/orders",
  },
];

export const attemptFixtures: readonly DeliveryAttempt[] = [
  {
    attempt: 1,
    completedAt: "2026-07-17T01:16:42.184Z",
    completedAtLabel: "01:16:42.184 UTC",
    endpoint: "Production ingestion",
    id: "attempt-1",
    latencyMs: 184,
    occurredAt: "2026-07-17T01:16:42Z",
    occurredAtLabel: "17 Jul 2026, 01:16:42 UTC",
    responseCode: 202,
    status: "delivered",
  },
];

export const backendFixtures: readonly BackendCapabilitySummary[] = [
  {
    cells: [
      {
        dimensionId: "durability",
        reason: "State, queue, and payload live only in process memory.",
        reasonCode: "DURABILITY_EPHEMERAL",
        status: "unsupported",
        value: "Ephemeral",
      },
      {
        dimensionId: "ack-barrier",
        reason: "No durable acknowledgement barrier before delivery.",
        reasonCode: "ACK_BARRIER_ABSENT",
        status: "unsupported",
        value: "None",
      },
      {
        dimensionId: "multi-replica",
        reason: "Process-local state cannot be shared across replicas.",
        reasonCode: "MULTI_REPLICA_UNSAFE",
        status: "unsupported",
        value: "Single process",
      },
      {
        dimensionId: "replay",
        reason: "Replay is limited to the current process lifetime.",
        reasonCode: "REPLAY_VOLATILE",
        status: "degraded",
        value: "Volatile",
      },
    ],
    deploymentModes: ["local"],
    externalServices: [],
    id: "memory",
    name: "Memory",
    reason: "Evaluation-only runtime with no durability guarantees.",
    reasonCode: "BACKEND_EVALUATION_ONLY",
    status: "unsupported",
    summary: "Ephemeral tests and demos",
  },
  {
    cells: [
      {
        dimensionId: "durability",
        reason: "Accepted events are committed to PostgreSQL before ack.",
        reasonCode: "DURABILITY_DISK",
        status: "supported",
        value: "Disk",
      },
      {
        dimensionId: "consistency",
        reason: "Transactional reads observe committed writes.",
        reasonCode: "CONSISTENCY_STRONG",
        status: "supported",
        value: "Strong",
      },
      {
        dimensionId: "ack-barrier",
        reason: "Protocol-v1 acknowledgement is durable through PostgreSQL.",
        reasonCode: "ACK_BARRIER_DURABLE",
        status: "supported",
        value: "Durable",
      },
      {
        dimensionId: "ordering",
        reason: "Ordering is configurable per endpoint.",
        reasonCode: "ORDERING_ENDPOINT",
        status: "supported",
        value: "Per endpoint",
      },
      {
        dimensionId: "retry",
        reason: "Native run_at query drives delayed retries.",
        reasonCode: "RETRY_NATIVE",
        status: "supported",
        value: "Native run_at",
      },
      {
        dimensionId: "fencing",
        reason: "Row leases fence concurrent workers.",
        reasonCode: "FENCING_LEASE",
        status: "supported",
        value: "Lease",
      },
      {
        dimensionId: "replay",
        reason: "Deliveries can be replayed and redriven from durable state.",
        reasonCode: "REPLAY_DURABLE",
        status: "supported",
        value: "Durable",
      },
      {
        dimensionId: "dlq",
        reason: "Exhausted deliveries are captured in a dead-letter table.",
        reasonCode: "DLQ_SUPPORTED",
        status: "supported",
        value: "Supported",
      },
      {
        dimensionId: "multi-replica",
        reason: "Multiple API and worker replicas share PostgreSQL safely.",
        reasonCode: "MULTI_REPLICA_SAFE",
        status: "supported",
        value: "Safe",
      },
      {
        dimensionId: "external-service",
        reason: "Requires a single PostgreSQL instance.",
        reasonCode: "EXTERNAL_SERVICE_POSTGRES",
        status: "supported",
        value: "PostgreSQL",
      },
      {
        dimensionId: "deployment",
        reason: "Runs locally, on a VM, or in a customer cloud.",
        reasonCode: "DEPLOYMENT_MULTI",
        status: "supported",
        value: "local, vm, byoc",
      },
    ],
    deploymentModes: ["local", "vm", "byoc"],
    externalServices: ["PostgreSQL"],
    id: "postgres",
    name: "PostgreSQL",
    reason: "Simplest durable runtime; the protocol-v1 source of truth.",
    reasonCode: "BACKEND_SUPPORTED",
    recommended: true,
    status: "supported",
    summary: "Simplest durable local/VM",
  },
];

export const unsupportedBackendFixture: BackendCapabilitySummary =
  backendFixtures[0]!;

export const supportedBackendFixture: BackendCapabilitySummary =
  backendFixtures[1]!;

export const backendSelectionIssueFixtures: readonly BackendSelectionIssue[] = [
  {
    code: "MISSING_EXTERNAL_SERVICE",
    dimensionId: "external-service",
    message: "Kafka broker endpoints are not configured.",
    severity: "error",
  },
];
