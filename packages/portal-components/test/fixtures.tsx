// SPDX-License-Identifier: Apache-2.0

import type {
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
