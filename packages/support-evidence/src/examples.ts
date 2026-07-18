// SPDX-License-Identifier: Apache-2.0

import { createEvidenceBundle } from "./bundle.js";
import { deepFreeze } from "./internal.js";
import type { EvidenceBundleInput } from "./types.js";

export const EXAMPLE_SUPPORT_EVIDENCE_INPUT: EvidenceBundleInput = deepFreeze({
  supportCaseId: "case_demo_01",
  tenantScope: {
    tenantId: {
      kind: "hashed",
      algorithm: "sha256",
      value: "1".repeat(64),
    },
    environmentId: {
      kind: "opaque",
      value: "env_demo",
    },
  },
  selection: {
    from: "2026-07-18T10:00:00.000Z",
    to: "2026-07-18T10:05:00.000Z",
    purpose: "case-review",
  },
  records: [
    {
      recordType: "event",
      sourceId: "provider_export_01",
      occurredAt: "2026-07-18T10:01:00.000Z",
      ingestedAt: "2026-07-18T10:01:00.125Z",
      eventType: "invoice.created",
      eventVersion: "2026-01",
      providerEventRef: "evt_demo_01",
      endpointId: "endpoint_demo_01",
      status: "accepted",
      correlationId: "corr_demo_01",
    },
    {
      recordType: "attempt",
      sourceId: "provider_export_01",
      occurredAt: "2026-07-18T10:01:01.000Z",
      ingestedAt: "2026-07-18T10:01:01.200Z",
      eventType: "invoice.created",
      eventVersion: "2026-01",
      providerEventRef: "evt_demo_01",
      providerAttemptRef: "attempt_demo_01",
      endpointId: "endpoint_demo_01",
      status: "delivered",
      responseCode: 202,
      latencyMs: 185,
      retryCategory: "none",
      correlationId: "corr_demo_01",
    },
  ],
  contractReferences: [
    {
      contractId: "billing_events",
      version: "2026-01",
      checksum: {
        algorithm: "sha256",
        value: "2".repeat(64),
      },
    },
  ],
  sources: [
    {
      sourceId: "provider_export_01",
      checksum: {
        algorithm: "sha256",
        value: "3".repeat(64),
      },
      recordCount: 2,
    },
  ],
  createdAt: "2026-07-18T10:06:00.000Z",
  expiresAt: "2026-07-25T10:06:00.000Z",
});

export function createExampleEvidenceBundle() {
  return createEvidenceBundle(EXAMPLE_SUPPORT_EVIDENCE_INPUT);
}
