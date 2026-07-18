// SPDX-License-Identifier: Apache-2.0

import type { JsonSchema } from "@webhook-portal/canonical-model";

import {
  MIGRATION_INVENTORY_FORMAT,
  MIGRATION_INVENTORY_FORMAT_VERSION,
  MIGRATION_INVENTORY_SCHEMA_ID,
  MIGRATION_INVENTORY_SCHEMA_VERSION,
} from "./types.js";

const boundedString = { maxLength: 512, minLength: 1, type: "string" } as const;
const featureProperties = {
  attemptLogs: { type: "boolean" },
  auditLogs: { type: "boolean" },
  deliveryLogs: { type: "boolean" },
  metrics: { type: "boolean" },
  replay: { type: "boolean" },
} as const;

export const MIGRATION_INVENTORY_JSON_SCHEMA: JsonSchema = {
  $defs: {
    destination: {
      additionalProperties: false,
      properties: {
        id: boundedString,
        kind: { const: "http" },
        providerId: boundedString,
        url: { format: "uri", maxLength: 2048, type: "string" },
      },
      required: ["id", "kind", "url"],
      type: "object",
    },
    endpoint: {
      additionalProperties: false,
      properties: {
        destinationIds: {
          items: boundedString,
          maxItems: 100,
          type: "array",
          uniqueItems: true,
        },
        id: boundedString,
        name: boundedString,
        observability: {
          additionalProperties: false,
          properties: featureProperties,
          required: [
            "attemptLogs",
            "auditLogs",
            "deliveryLogs",
            "metrics",
            "replay",
          ],
          type: "object",
        },
        providerId: boundedString,
        rate: {
          additionalProperties: false,
          properties: {
            burst: { minimum: 0, type: "number" },
            requestsPerSecond: { minimum: 0, type: "number" },
            supported: { type: "boolean" },
          },
          required: ["supported"],
          type: "object",
        },
        retention: {
          additionalProperties: false,
          properties: {
            attemptLogDays: { minimum: 0, type: "number" },
            deliveryLogDays: { minimum: 0, type: "number" },
            payloadRetentionDays: { minimum: 0, type: "number" },
          },
          type: "object",
        },
        retry: {
          additionalProperties: false,
          properties: {
            backoff: {
              enum: ["exponential", "fixed", "provider-managed", "unknown"],
            },
            maxAttempts: { minimum: 0, type: "integer" },
            maxDurationSeconds: { minimum: 0, type: "number" },
            supported: { type: "boolean" },
          },
          required: ["supported"],
          type: "object",
        },
        signing: {
          additionalProperties: false,
          properties: {
            algorithms: {
              items: boundedString,
              maxItems: 16,
              type: "array",
              uniqueItems: true,
            },
            headerNames: {
              items: boundedString,
              maxItems: 32,
              type: "array",
              uniqueItems: true,
            },
            profile: boundedString,
            rotationSupported: { type: "boolean" },
          },
          required: [
            "algorithms",
            "headerNames",
            "profile",
            "rotationSupported",
          ],
          type: "object",
        },
        state: { enum: ["active", "disabled", "paused", "unknown"] },
        subscriptions: {
          items: {
            additionalProperties: false,
            properties: {
              event: boundedString,
              providerId: boundedString,
            },
            required: ["event"],
            type: "object",
          },
          maxItems: 500,
          type: "array",
        },
      },
      required: [
        "destinationIds",
        "id",
        "observability",
        "providerId",
        "rate",
        "retention",
        "retry",
        "state",
      ],
      type: "object",
    },
  },
  $id: MIGRATION_INVENTORY_SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    $schema: { const: MIGRATION_INVENTORY_SCHEMA_ID },
    destinations: {
      items: { $ref: "#/$defs/destination" },
      maxItems: 1000,
      type: "array",
    },
    endpoints: {
      items: { $ref: "#/$defs/endpoint" },
      maxItems: 1000,
      type: "array",
    },
    format: { const: MIGRATION_INVENTORY_FORMAT },
    formatVersion: { const: MIGRATION_INVENTORY_FORMAT_VERSION },
    provider: {
      additionalProperties: false,
      properties: {
        accountId: boundedString,
        connectionId: boundedString,
        kind: { enum: ["custom-http", "hookdeck", "svix"] },
        name: boundedString,
      },
      required: ["accountId", "kind"],
      type: "object",
    },
    schemaVersion: { const: MIGRATION_INVENTORY_SCHEMA_VERSION },
  },
  required: [
    "$schema",
    "destinations",
    "endpoints",
    "format",
    "formatVersion",
    "provider",
    "schemaVersion",
  ],
  type: "object",
};
