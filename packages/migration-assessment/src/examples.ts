// SPDX-License-Identifier: Apache-2.0

import {
  MIGRATION_INVENTORY_FORMAT,
  MIGRATION_INVENTORY_FORMAT_VERSION,
  MIGRATION_INVENTORY_SCHEMA_ID,
  MIGRATION_INVENTORY_SCHEMA_VERSION,
  type MigrationInventory,
  type TargetPolicy,
} from "./types.js";

export const EXAMPLE_CUSTOM_HTTP_INVENTORY = Object.freeze({
  $schema: MIGRATION_INVENTORY_SCHEMA_ID,
  destinations: [
    {
      id: "destination-orders",
      kind: "http",
      providerId: "receiver-orders",
      url: "https://receiver.example/webhooks/orders",
    },
  ],
  endpoints: [
    {
      destinationIds: ["destination-orders"],
      id: "orders-production",
      name: "Orders production",
      observability: {
        attemptLogs: true,
        auditLogs: false,
        deliveryLogs: true,
        metrics: true,
        replay: true,
      },
      providerId: "orders-production",
      rate: { requestsPerSecond: 100, supported: true },
      retention: { attemptLogDays: 7, deliveryLogDays: 30 },
      retry: {
        backoff: "exponential",
        maxAttempts: 8,
        supported: true,
      },
      signing: {
        algorithms: ["hmac-sha256"],
        headerNames: ["webhook-signature"],
        profile: "standard-hmac",
        rotationSupported: true,
      },
      state: "active",
      subscriptions: [{ event: "order.created" }],
    },
  ],
  format: MIGRATION_INVENTORY_FORMAT,
  formatVersion: MIGRATION_INVENTORY_FORMAT_VERSION,
  provider: {
    accountId: "account-production",
    kind: "custom-http",
    name: "Existing HTTP delivery",
  },
  schemaVersion: MIGRATION_INVENTORY_SCHEMA_VERSION,
} satisfies MigrationInventory);

export const EXAMPLE_TARGET_POLICY = Object.freeze({
  allowedSigningAlgorithms: ["hmac-sha256"],
  endpointLimit: 100,
  minimumRetention: { attemptLogDays: 7, deliveryLogDays: 30 },
  observability: {
    attemptLogs: true,
    deliveryLogs: true,
    metrics: true,
    replay: true,
  },
  rate: { maxBurst: 200, maxRequestsPerSecond: 100, supported: true },
  requireHttps: true,
  requireRollbackExport: true,
  requireSigning: true,
  retry: { maxAttempts: 10, supported: true },
  subscriptionLimitPerEndpoint: 100,
} satisfies TargetPolicy);
