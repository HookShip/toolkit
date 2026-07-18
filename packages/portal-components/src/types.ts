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
