// SPDX-License-Identifier: Apache-2.0

import { assertEvidenceBundleIntegrity } from "./bundle.js";
import { stableJson } from "./canonical.js";
import {
  HARD_EVIDENCE_LIMITS,
  type EvidenceRecord,
  type TenantIdentifier,
} from "./types.js";

export const EVIDENCE_LIMITATIONS = Object.freeze([
  "Metadata only: payloads, bodies, headers, URLs, query strings, credentials, cookies, payment data, and PII are excluded.",
  "The snapshot is limited to the supplied sources and operator-selected time range.",
  "Timestamps, statuses, and provider references are recorded as supplied metadata.",
  "The bundle does not determine causation, responsibility, correctness, or outcome.",
] as const);

export function escapeMarkdownText(value: string): string {
  const withoutControls = value.replace(
    /[\u0000-\u001f\u007f]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const htmlSafe = withoutControls
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
  return htmlSafe.replace(/[\\`*_[\]{}()#+.!|~-]/gu, "\\$&");
}

function markdownValue(value: number | string | undefined): string {
  return value === undefined ? "-" : escapeMarkdownText(String(value));
}

function tenantIdentifier(identifier: TenantIdentifier): string {
  return identifier.kind === "hashed"
    ? `sha256:${identifier.value}`
    : identifier.value;
}

function recordRow(record: EvidenceRecord): string {
  return [
    record.recordType,
    record.occurredAt,
    record.ingestedAt,
    record.sourceId,
    record.eventType,
    record.eventVersion,
    record.providerEventRef,
    record.providerAttemptRef,
    record.endpointId,
    record.status,
    record.responseCode,
    record.latencyMs,
    record.retryCategory,
    record.traceId,
    record.correlationId,
  ]
    .map(markdownValue)
    .join(" | ");
}

export function renderEvidenceJson(input: unknown): string {
  const bundle = assertEvidenceBundleIntegrity(input);
  return `${stableJson(
    {
      evidence: bundle.snapshot,
      format: "webhook-portal.support-evidence-summary",
      integrity: {
        digest: bundle.digest,
        signature: bundle.signature ?? null,
      },
      limitations: EVIDENCE_LIMITATIONS,
      version: 1,
    },
    {
      maximumOutputBytes: HARD_EVIDENCE_LIMITS.maximumBytes + 256 * 1024,
    },
  )}\n`;
}

export function renderEvidenceMarkdown(input: unknown): string {
  const bundle = assertEvidenceBundleIntegrity(input);
  const { snapshot } = bundle;
  const lines = [
    "# Support evidence bundle",
    "",
    `- Case ID: ${markdownValue(snapshot.supportCaseId)}`,
    `- Created: ${markdownValue(snapshot.createdAt)}`,
    `- Expires: ${markdownValue(snapshot.expiresAt)}`,
    `- Records: ${markdownValue(snapshot.recordCount)}`,
    `- Redaction policy: ${markdownValue(snapshot.redactionPolicyVersion)}`,
    "",
    "## Tenant scope",
    "",
    `- Tenant: ${markdownValue(tenantIdentifier(snapshot.tenantScope.tenantId))}`,
  ];
  if (snapshot.tenantScope.environmentId !== undefined) {
    lines.push(
      `- Environment: ${markdownValue(
        tenantIdentifier(snapshot.tenantScope.environmentId),
      )}`,
    );
  }
  if (snapshot.tenantScope.projectId !== undefined) {
    lines.push(
      `- Project: ${markdownValue(
        tenantIdentifier(snapshot.tenantScope.projectId),
      )}`,
    );
  }

  lines.push(
    "",
    "## Selection",
    "",
    `- From: ${markdownValue(snapshot.selection.from)}`,
    `- To: ${markdownValue(snapshot.selection.to)}`,
    `- Purpose: ${markdownValue(snapshot.selection.purpose)}`,
    "",
    "## Sources",
    "",
    "Source | SHA-256 | Records",
    "--- | --- | ---:",
    ...snapshot.sources.map((source) =>
      [
        markdownValue(source.sourceId),
        markdownValue(source.checksum.value),
        markdownValue(source.recordCount),
      ].join(" | "),
    ),
    "",
    "## Contract references",
    "",
    "Contract | Version | SHA-256",
    "--- | --- | ---",
    ...snapshot.contractReferences.map((reference) =>
      [
        markdownValue(reference.contractId),
        markdownValue(reference.version),
        markdownValue(reference.checksum.value),
      ].join(" | "),
    ),
    "",
    "## Timeline metadata",
    "",
    "Kind | Occurred | Ingested | Source | Event type | Event version | Provider event | Provider attempt | Endpoint | Status | Response | Latency ms | Retry | Trace | Correlation",
    "--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | ---",
    ...snapshot.records.map(recordRow),
    "",
    "## Integrity",
    "",
    `- Digest: ${markdownValue(bundle.digest)}`,
    `- Signature algorithm: ${markdownValue(bundle.signature?.algorithm)}`,
    `- Signature key ID: ${markdownValue(bundle.signature?.keyId)}`,
    `- Signed: ${markdownValue(bundle.signature?.signedAt)}`,
    "",
    "## Limitations",
    "",
    ...EVIDENCE_LIMITATIONS.map(
      (limitation) => `- ${escapeMarkdownText(limitation)}`,
    ),
    "",
  );
  return lines.join("\n");
}
