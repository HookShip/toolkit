// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";

import { stableJson } from "@webhook-portal/canonical-model";

import type { CompatibilityReport } from "./report.js";

export { stableJson } from "@webhook-portal/canonical-model";

export function computeReportChecksum(
  report: Omit<CompatibilityReport, "integrity">,
): string {
  return createHash("sha256").update(stableJson(report), "utf8").digest("hex");
}

export interface ReportVerificationOptions {
  readonly nextCanonicalChecksum?: string;
  readonly previousCanonicalChecksum?: string;
}

export interface ReportVerificationResult {
  readonly errors: readonly string[];
  readonly valid: boolean;
}

export function verifyCompatibilityReport(
  report: CompatibilityReport,
  options: ReportVerificationOptions = {},
): ReportVerificationResult {
  const errors: string[] = [];
  if (report.format !== "webhook-portal.compatibility-report") {
    errors.push("Unsupported report format");
  }
  if (report.formatVersion !== "1.0.0") {
    errors.push("Unsupported report format version");
  }
  if (report.integrity.algorithm !== "sha256") {
    errors.push("Unsupported report checksum algorithm");
  } else {
    const { integrity: _integrity, ...unsigned } = report;
    void _integrity;
    const expected = computeReportChecksum(unsigned);
    const actualBytes = Buffer.from(report.integrity.value, "hex");
    const expectedBytes = Buffer.from(expected, "hex");
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      errors.push("Report checksum mismatch");
    }
  }
  if (
    options.previousCanonicalChecksum !== undefined &&
    report.lineage.previous.canonicalChecksum.value !==
      options.previousCanonicalChecksum
  ) {
    errors.push("Previous canonical checksum mismatch");
  }
  if (
    options.nextCanonicalChecksum !== undefined &&
    report.lineage.next.canonicalChecksum.value !==
      options.nextCanonicalChecksum
  ) {
    errors.push("Next canonical checksum mismatch");
  }
  return Object.freeze({
    errors: Object.freeze(errors),
    valid: errors.length === 0,
  });
}
