// SPDX-License-Identifier: Apache-2.0

import type { AdapterCapabilityDocument } from "@webhook-portal/adapter-sdk";
import type { CanonicalContract } from "@webhook-portal/canonical-model";

export const MIGRATION_INVENTORY_SCHEMA_VERSION = "2026-07-18" as const;
export const MIGRATION_INVENTORY_SCHEMA_ID =
  "https://webhook-portal.dev/schemas/migration-inventory/2026-07-18" as const;
export const MIGRATION_INVENTORY_FORMAT =
  "webhook-portal.migration-inventory" as const;
export const MIGRATION_INVENTORY_FORMAT_VERSION = "1.0.0" as const;
export const MIGRATION_ASSESSMENT_VERSION = "1.0.0" as const;

export type ProviderKind = "custom-http" | "hookdeck" | "svix";
export type EndpointState = "active" | "disabled" | "paused" | "unknown";
export type DiagnosticSeverity = "error" | "fatal" | "info" | "warning";

export interface AssessmentDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly pointer?: string;
  readonly severity: DiagnosticSeverity;
}

export interface ProviderIdentity {
  readonly accountId: string;
  readonly connectionId?: string;
  readonly kind: ProviderKind;
  readonly name?: string;
}

export interface InventorySigningProfile {
  readonly algorithms: readonly string[];
  readonly headerNames: readonly string[];
  readonly profile: string;
  readonly rotationSupported: boolean;
}

export interface RetryCapability {
  readonly backoff?: "exponential" | "fixed" | "provider-managed" | "unknown";
  readonly maxAttempts?: number;
  readonly maxDurationSeconds?: number;
  readonly supported: boolean;
}

export interface RateCapability {
  readonly burst?: number;
  readonly requestsPerSecond?: number;
  readonly supported: boolean;
}

export interface RetentionFeatures {
  readonly attemptLogDays?: number;
  readonly deliveryLogDays?: number;
  readonly payloadRetentionDays?: number;
}

export interface ObservabilityFeatures {
  readonly attemptLogs: boolean;
  readonly auditLogs: boolean;
  readonly deliveryLogs: boolean;
  readonly metrics: boolean;
  readonly replay: boolean;
}

export interface InventoryDestination {
  readonly id: string;
  readonly kind: "http";
  readonly providerId?: string;
  readonly url: string;
}

export interface EventSubscription {
  readonly event: string;
  readonly providerId?: string;
}

export interface InventoryEndpoint {
  readonly destinationIds: readonly string[];
  readonly id: string;
  readonly name?: string;
  readonly observability: ObservabilityFeatures;
  readonly providerId: string;
  readonly rate: RateCapability;
  readonly retention: RetentionFeatures;
  readonly retry: RetryCapability;
  readonly signing?: InventorySigningProfile;
  readonly state: EndpointState;
  readonly subscriptions?: readonly EventSubscription[];
}

export interface MigrationInventory {
  readonly $schema: typeof MIGRATION_INVENTORY_SCHEMA_ID;
  readonly destinations: readonly InventoryDestination[];
  readonly endpoints: readonly InventoryEndpoint[];
  readonly format: typeof MIGRATION_INVENTORY_FORMAT;
  readonly formatVersion: typeof MIGRATION_INVENTORY_FORMAT_VERSION;
  readonly provider: ProviderIdentity;
  readonly schemaVersion: typeof MIGRATION_INVENTORY_SCHEMA_VERSION;
}

export interface ImportLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxDestinations: number;
  readonly maxEndpoints: number;
  readonly maxObjectProperties: number;
  readonly maxSubscriptions: number;
  readonly maxTotalValues: number;
}

export interface InventoryImportResult {
  readonly diagnostics: readonly AssessmentDiagnostic[];
  readonly inventory?: MigrationInventory;
  readonly ok: boolean;
}

export interface TargetPolicy {
  readonly allowedSigningAlgorithms?: readonly string[];
  readonly endpointLimit?: number;
  readonly minimumRetention?: RetentionFeatures;
  readonly observability?: Partial<ObservabilityFeatures>;
  readonly rate?: {
    readonly maxBurst?: number;
    readonly maxRequestsPerSecond?: number;
    readonly supported: boolean;
  };
  readonly requireHttps?: boolean;
  readonly requireRollbackExport?: boolean;
  readonly requireSigning?: boolean;
  readonly retry?: {
    readonly maxAttempts?: number;
    readonly maxDurationSeconds?: number;
    readonly supported: boolean;
  };
  readonly subscriptionLimitPerEndpoint?: number;
}

export interface AssessmentInput {
  readonly capabilities: AdapterCapabilityDocument;
  readonly contract: CanonicalContract;
  readonly inventory: MigrationInventory;
  readonly targetPolicy?: TargetPolicy;
}

export interface AssessmentCounts {
  readonly destinations: number;
  readonly endpoints: number;
  readonly events: number;
  readonly pausedEndpoints: number;
  readonly subscriptions: number;
}

export interface EventMapping {
  readonly canonicalEventId?: string;
  readonly canonicalExternalName?: string;
  readonly sourceEvent: string;
  readonly status: "ambiguous" | "mapped" | "unmapped";
}

export interface EndpointMapping {
  readonly destinationIds: readonly string[];
  readonly events: readonly EventMapping[];
  readonly sourceEndpointId: string;
  readonly sourceProviderId: string;
  readonly targetReference: string;
}

export interface AssessmentIssue {
  readonly code: string;
  readonly message: string;
  readonly sourceId?: string;
}

export interface CapabilityParityItem {
  readonly operation: string;
  readonly required: boolean;
  readonly sourceReason: string;
  readonly status: "degraded" | "not-required" | "supported" | "unsupported";
}

export interface RollbackPrerequisite {
  readonly code: string;
  readonly message: string;
  readonly status: "met" | "unmet" | "unknown";
}

export interface MigrationPhase {
  readonly id:
    | "cutover"
    | "decommission"
    | "discover"
    | "monitor"
    | "provision"
    | "verify";
  readonly name: string;
  readonly readOnlyAssessment: true;
  readonly steps: readonly string[];
}

export interface ScoreComponent {
  readonly earned: number;
  readonly id:
    "capability" | "mapping" | "operations" | "rollback" | "security";
  readonly rationale: string;
  readonly score: number;
  readonly weight: number;
}

export interface ReadinessScore {
  readonly blocked: boolean;
  readonly components: readonly ScoreComponent[];
  readonly label: "blocked" | "high" | "low" | "moderate";
  readonly score: number;
  readonly statement: string;
}

export interface MigrationAssessment {
  readonly assessmentVersion: typeof MIGRATION_ASSESSMENT_VERSION;
  readonly blockers: readonly AssessmentIssue[];
  readonly capabilityParity: readonly CapabilityParityItem[];
  readonly counts: AssessmentCounts;
  readonly endpointMappings: readonly EndpointMapping[];
  readonly inventoryChecksum: {
    readonly algorithm: "sha256";
    readonly value: string;
  };
  readonly migrationPhases: readonly MigrationPhase[];
  readonly provider: ProviderIdentity;
  readonly readiness: ReadinessScore;
  readonly retentionObservabilityGaps: readonly AssessmentIssue[];
  readonly rollbackPrerequisites: readonly RollbackPrerequisite[];
  readonly signingSecurityGaps: readonly AssessmentIssue[];
  readonly targetAdapter: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  };
  readonly unmappedOrAmbiguous: readonly AssessmentIssue[];
  readonly warnings: readonly AssessmentIssue[];
}

export interface RenderOptions {
  readonly maxBytes?: number;
}
