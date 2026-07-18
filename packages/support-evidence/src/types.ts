// SPDX-License-Identifier: Apache-2.0

export const SUPPORT_EVIDENCE_FORMAT =
  "webhook-portal.support-evidence" as const;
export const SUPPORT_EVIDENCE_FORMAT_VERSION = 1 as const;
export const REDACTION_POLICY_VERSION = "support-evidence-metadata-v1" as const;

export const EVIDENCE_PURPOSES = [
  "case-review",
  "contract-verification",
  "delivery-verification",
  "incident-correlation",
  "provider-escalation",
  "timeline-review",
] as const;

export type EvidencePurpose = (typeof EVIDENCE_PURPOSES)[number];

export const RETRY_CATEGORIES = [
  "none",
  "permanent",
  "rate-limited",
  "scheduled",
  "transient",
  "unknown",
] as const;

export type RetryCategory = (typeof RETRY_CATEGORIES)[number];

export interface EvidenceLimits {
  readonly maximumRecords: number;
  readonly maximumBytes: number;
  readonly maximumTimeRangeMs: number;
  readonly maximumBundleLifetimeMs: number;
}

export type EvidenceLimitOverrides = Partial<EvidenceLimits>;

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = Object.freeze({
  maximumRecords: 1_000,
  maximumBytes: 1024 * 1024,
  maximumTimeRangeMs: 31 * 24 * 60 * 60 * 1_000,
  maximumBundleLifetimeMs: 30 * 24 * 60 * 60 * 1_000,
});

export const HARD_EVIDENCE_LIMITS: EvidenceLimits = Object.freeze({
  maximumRecords: 10_000,
  maximumBytes: 4 * 1024 * 1024,
  maximumTimeRangeMs: 90 * 24 * 60 * 60 * 1_000,
  maximumBundleLifetimeMs: 90 * 24 * 60 * 60 * 1_000,
});

export interface OpaqueTenantIdentifier {
  readonly kind: "opaque";
  readonly value: string;
}

export interface HashedTenantIdentifier {
  readonly kind: "hashed";
  readonly algorithm: "sha256";
  readonly value: string;
}

export type TenantIdentifier = HashedTenantIdentifier | OpaqueTenantIdentifier;

export interface TenantScope {
  readonly tenantId: TenantIdentifier;
  readonly environmentId?: TenantIdentifier;
  readonly projectId?: TenantIdentifier;
}

export interface EvidenceSelection {
  readonly from: string;
  readonly to: string;
  readonly purpose: EvidencePurpose;
}

export interface Sha256Checksum {
  readonly algorithm: "sha256";
  readonly value: string;
}

export interface ContractReference {
  readonly contractId: string;
  readonly version: string;
  readonly checksum: Sha256Checksum;
}

export interface EvidenceSource {
  readonly sourceId: string;
  readonly checksum: Sha256Checksum;
  readonly recordCount: number;
}

export interface EvidenceRecord {
  readonly recordType: "attempt" | "event";
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly ingestedAt: string;
  readonly eventType?: string;
  readonly eventVersion?: string;
  readonly providerEventRef?: string;
  readonly providerAttemptRef?: string;
  readonly endpointId?: string;
  readonly status?: string;
  readonly responseCode?: number;
  readonly latencyMs?: number;
  readonly retryCategory?: RetryCategory;
  readonly traceId?: string;
  readonly correlationId?: string;
}

export interface EvidenceBundleInput {
  readonly supportCaseId: string;
  readonly tenantScope: TenantScope;
  readonly selection: EvidenceSelection;
  readonly records: readonly EvidenceRecord[];
  readonly contractReferences: readonly ContractReference[];
  readonly sources: readonly EvidenceSource[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SanitizedEvidenceInput extends EvidenceBundleInput {
  readonly limits: EvidenceLimits;
}

export interface EvidenceSnapshot extends EvidenceBundleInput {
  readonly format: typeof SUPPORT_EVIDENCE_FORMAT;
  readonly formatVersion: typeof SUPPORT_EVIDENCE_FORMAT_VERSION;
  readonly recordCount: number;
  readonly redactionPolicyVersion: typeof REDACTION_POLICY_VERSION;
  readonly limits: EvidenceLimits;
}

export type Sha256Digest = `sha256:${string}`;

export interface EvidenceSignature {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signedAt: string;
  readonly value: string;
}

export interface EvidenceBundle {
  readonly snapshot: EvidenceSnapshot;
  readonly digest: Sha256Digest;
  readonly signature?: EvidenceSignature;
}

export type IntegrityStatus = "malformed" | "tampered" | "valid";
export type ExpiryStatus = "expired" | "not-yet-created" | "unknown" | "valid";
export type SignatureStatus =
  | "ambiguous-key"
  | "invalid"
  | "key-expired"
  | "key-not-yet-valid"
  | "malformed"
  | "not-yet-valid"
  | "revoked-key"
  | "unsigned"
  | "untrusted-key"
  | "valid";

export type VerificationIssueCode =
  | "AMBIGUOUS_KEY"
  | "BUNDLE_EXPIRED"
  | "BUNDLE_NOT_YET_CREATED"
  | "DIGEST_MISMATCH"
  | "INVALID_SIGNATURE"
  | "KEY_EXPIRED"
  | "KEY_NOT_YET_VALID"
  | "KEY_REVOKED"
  | "MALFORMED_BUNDLE"
  | "SIGNATURE_NOT_YET_VALID"
  | "SIGNATURE_REQUIRED"
  | "UNTRUSTED_KEY";

export interface EvidenceVerificationResult {
  readonly valid: boolean;
  readonly integrity: IntegrityStatus;
  readonly expiry: ExpiryStatus;
  readonly signature: SignatureStatus;
  readonly issues: readonly VerificationIssueCode[];
  readonly keyId?: string;
}

export interface AvailableResolutionDuration {
  readonly status: "available";
  readonly openedAt: string;
  readonly resolvedAt: string;
  readonly durationMs: number;
}

export interface UnavailableResolutionDuration {
  readonly status: "unavailable";
  readonly reason: "resolved-at-not-supplied";
  readonly openedAt: string;
}

export type ResolutionDuration =
  AvailableResolutionDuration | UnavailableResolutionDuration;
