// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export type PortalTheme = "paper" | "ink" | "auto";

export interface PortalThemeTokens {
  accent?: string;
  background?: string;
  border?: string;
  critical?: string;
  fontBody?: string;
  fontDisplay?: string;
  fontMono?: string;
  ink?: string;
  muted?: string;
  radius?: string;
  surface?: string;
  warning?: string;
}

export interface EventVersion {
  deprecated?: boolean;
  label?: string;
  value: string;
}

export interface EventSummary {
  category?: string;
  deprecated?: boolean;
  description: ReactNode;
  href: string;
  id: string;
  name: string;
  version: string;
}

export interface SchemaProperty {
  deprecated?: boolean;
  description?: ReactNode;
  example?: ReactNode;
  name: string;
  required?: boolean;
  type: string;
}

export type EndpointStatus =
  "active" | "disabled" | "failing" | "pending" | "paused";

export interface EndpointSummary {
  description?: ReactNode;
  eventCount?: number;
  href?: string;
  id: string;
  name: string;
  status: EndpointStatus;
  updatedAt?: string;
  updatedAtLabel?: string;
  url: string;
}

export type SecretRotationStatus = "failed" | "overlap" | "pending" | "stable";

export type DeliveryStatus =
  "canceled" | "delivered" | "failed" | "pending" | "queued" | "retrying";

export interface DeliveryAttempt {
  actions?: ReactNode;
  attempt: number;
  completedAt?: string;
  completedAtLabel?: string;
  endpoint?: string;
  id: string;
  latencyMs?: number;
  message?: ReactNode;
  occurredAt: string;
  occurredAtLabel: string;
  responseCode?: number;
  status: DeliveryStatus;
}

/**
 * Support level a delivery backend declares for a capability or for its overall
 * configuration. Ordered from most to least capable; `unsupported` blocks
 * backend selection confirmation.
 */
export type BackendCapabilityStatus =
  "degraded" | "experimental" | "supported" | "unsupported";

/**
 * A stable dimension along which delivery backends are compared. These view
 * models are plain and serializable: components never import the private
 * hook-service runtime capability schema and instead render pre-validated data.
 */
export interface BackendCapabilityDimension {
  /** Stable machine identifier, e.g. `"durability"` or `"multi-replica"`. */
  id: string;
  /** Short human label shown as the matrix row header. */
  label: string;
  /** Optional bounded description of what the dimension measures. */
  description?: string;
}

/** A single backend/dimension intersection in the capability matrix. */
export interface BackendCapabilityCell {
  /** Identifier of the {@link BackendCapabilityDimension} this cell describes. */
  dimensionId: string;
  status: BackendCapabilityStatus;
  /** Short human-readable value, e.g. `"Replicated"` or `"Partition scoped"`. */
  value: string;
  /** Stable machine reason code, e.g. `"DURABILITY_REPLICATED"`. */
  reasonCode: string;
  /** Bounded human reason paired with {@link reasonCode}. */
  reason: string;
}

/** A delivery backend column in the capability matrix / selection review. */
export interface BackendCapabilitySummary {
  /** Stable backend identifier, e.g. `"postgres-kafka"`. */
  id: string;
  /** Display name, e.g. `"PostgreSQL + Kafka"`. */
  name: string;
  /** Overall support level for the backend as configured. */
  status: BackendCapabilityStatus;
  /** Stable machine reason code for the overall {@link status}. */
  reasonCode: string;
  /** Bounded human reason paired with {@link reasonCode}. */
  reason: string;
  /** Optional short positioning summary, e.g. intended use. */
  summary?: string;
  /** Whether the product recommends this backend for the current context. */
  recommended?: boolean;
  /** Per-dimension capability cells, keyed by dimension id. */
  cells: readonly BackendCapabilityCell[];
  /** External services the backend requires, e.g. `["PostgreSQL", "Kafka"]`. */
  externalServices?: readonly string[];
  /** Supported deployment modes, e.g. `["local", "vm", "byoc"]`. */
  deploymentModes?: readonly string[];
}

/** Severity for a backend selection validation issue. */
export type BackendSelectionSeverity = "error" | "warning";

/** A validation issue surfaced while reviewing a backend selection. */
export interface BackendSelectionIssue {
  /** Stable machine code, e.g. `"MISSING_EXTERNAL_SERVICE"`. */
  code: string;
  /** Bounded human message. */
  message: string;
  severity: BackendSelectionSeverity;
  /** Optional dimension id the issue relates to. */
  dimensionId?: string;
}
