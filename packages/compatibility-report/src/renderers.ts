// SPDX-License-Identifier: Apache-2.0

import type { CompatibilityReport, ReportChange } from "./report.js";
import { stableJson } from "./verification.js";

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/gu, "\\$1")
    .replace(/\r?\n|\r/gu, " ");
}

function changeLine(change: ReportChange): string {
  const version =
    change.version === undefined
      ? ""
      : `; version ${markdownText(change.version)}`;
  return `- **${markdownText(change.severity.toUpperCase())} / ${markdownText(change.priority)}** ${markdownText(change.title)} (\`${markdownText(change.code)}\`${version}) — ${markdownText(change.finding)} Evidence: \`${markdownText(change.evidence.canonicalPointer || "/")}\`.`;
}

export function renderCompatibilityReportJson(
  report: CompatibilityReport,
): string {
  return stableJson(report, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderCompatibilityReportMarkdown(
  report: CompatibilityReport,
): string {
  const lines: string[] = [
    "# Compatibility report",
    "",
    `**Status:** ${markdownText(report.status)}`,
    `**Decision:** ${markdownText(report.decision)}`,
    `**View:** ${markdownText(report.view)}`,
    "",
    "## Executive summary",
    "",
    markdownText(report.executiveSummary.headline),
    "",
    markdownText(report.executiveSummary.statement),
    "",
  ];

  if (report.view !== "consumer") {
    lines.push(
      "## Producer impact",
      "",
      markdownText(report.producerImpact.summary),
      "",
    );
  }
  if (report.view !== "producer") {
    lines.push(
      "## Consumer impact",
      "",
      markdownText(report.consumerImpact.summary),
      "",
    );
  }

  lines.push("## Changes", "");
  if (report.groups.length === 0) {
    lines.push("No semantic changes were reported.", "");
  }
  for (const group of report.groups) {
    lines.push(
      group.scope === "contract"
        ? "### Contract"
        : `### Event: ${markdownText(group.eventName ?? group.eventId ?? "unknown")}`,
      "",
      ...group.changes.map((change) => changeLine(change)),
      "",
    );
  }

  lines.push("## Required remediation", "");
  if (report.remediation.required.length === 0) {
    lines.push("No required remediation was generated.", "");
  } else {
    lines.push(
      ...report.remediation.required.map(
        (step) => `- ${markdownText(step.instruction)}`,
      ),
      "",
    );
  }
  lines.push("## Recommended remediation", "");
  if (report.remediation.recommended.length === 0) {
    lines.push("No recommended remediation was generated.", "");
  } else {
    lines.push(
      ...report.remediation.recommended.map(
        (step) => `- ${markdownText(step.instruction)}`,
      ),
      "",
    );
  }

  lines.push(
    "## Rollout guidance",
    "",
    `- **Dual version:** ${markdownText(report.rollout.dualVersion.guidance)}`,
    `- **Testing:** ${markdownText(report.rollout.testing.guidance)}`,
    `- **Rollback:** ${markdownText(report.rollout.rollback.guidance)}`,
    "",
    "## Uncertainty",
    "",
  );
  if (report.uncertainty.disclosures.length === 0) {
    lines.push("No additional uncertainty disclosures.", "");
  } else {
    lines.push(
      ...report.uncertainty.disclosures.map(
        (disclosure) => `- ${markdownText(disclosure)}`,
      ),
      "",
    );
  }
  lines.push(
    "## Lineage and integrity",
    "",
    `- Previous canonical SHA-256: \`${report.lineage.previous.canonicalChecksum.value}\``,
    `- Next canonical SHA-256: \`${report.lineage.next.canonicalChecksum.value}\``,
    `- Previous parser: ${markdownText(report.lineage.previous.parser.name)} ${markdownText(report.lineage.previous.parser.version)}`,
    `- Next parser: ${markdownText(report.lineage.next.parser.name)} ${markdownText(report.lineage.next.parser.version)}`,
    `- Report SHA-256: \`${report.integrity.value}\``,
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
