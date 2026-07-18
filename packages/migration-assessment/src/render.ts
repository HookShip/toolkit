// SPDX-License-Identifier: Apache-2.0

import { stableStringify } from "./stable.js";
import type {
  AssessmentIssue,
  MigrationAssessment,
  RenderOptions,
} from "./types.js";

export const DEFAULT_RENDER_MAX_BYTES = 2_097_152;

function enforceBoundedOutput(
  value: string,
  options: RenderOptions,
  format: string,
): string {
  const maxBytes = options.maxBytes ?? DEFAULT_RENDER_MAX_BYTES;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > maxBytes) {
    throw new RangeError(
      `${format} assessment is ${byteLength} bytes; maximum is ${maxBytes}.`,
    );
  }
  return value;
}

export function renderAssessmentJson(
  assessment: MigrationAssessment,
  options: RenderOptions = {},
): string {
  return enforceBoundedOutput(
    `${stableStringify(assessment, 2)}\n`,
    options,
    "JSON",
  );
}

function markdownText(value: string): string {
  return value
    .normalize("NFC")
    .replaceAll(/[\u0000-\u001f\u007f]/gu, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll(/([`*_[\]{}()#+\-.!|>])/gu, "\\$1")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function issueList(items: readonly AssessmentIssue[]): string[] {
  if (items.length === 0) {
    return ["- None"];
  }
  return items.map(
    (item) =>
      `- **${markdownText(item.code)}**${item.sourceId === undefined ? "" : ` \\(${markdownText(item.sourceId)}\\)`}: ${markdownText(item.message)}`,
  );
}

export function renderAssessmentMarkdown(
  assessment: MigrationAssessment,
  options: RenderOptions = {},
): string {
  const lines = [
    "# Migration assessment",
    "",
    "> Read-only planning output. It does not perform, authorize, or guarantee a migration.",
    "",
    "## Summary",
    "",
    `- Inventory checksum: \`${assessment.inventoryChecksum.algorithm}:${assessment.inventoryChecksum.value}\``,
    `- Source provider: ${markdownText(assessment.provider.kind)}`,
    `- Source account: ${markdownText(assessment.provider.accountId)}`,
    `- Target adapter: ${markdownText(assessment.targetAdapter.id)} ${markdownText(assessment.targetAdapter.version)}`,
    `- Endpoints / destinations / subscriptions: ${assessment.counts.endpoints} / ${assessment.counts.destinations} / ${assessment.counts.subscriptions}`,
    `- Readiness: **${markdownText(assessment.readiness.label)}**, ${assessment.readiness.score}/100`,
    `- Blockers: **${assessment.blockers.length}**`,
    "",
    markdownText(assessment.readiness.statement),
    "",
    "## Score components",
    "",
    "| Component | Weight | Score | Earned | Rationale |",
    "| --- | ---: | ---: | ---: | --- |",
    ...assessment.readiness.components.map(
      (item) =>
        `| ${markdownText(item.id)} | ${item.weight} | ${item.score} | ${item.earned} | ${markdownText(item.rationale)} |`,
    ),
    "",
    "## Blockers",
    "",
    ...issueList(assessment.blockers),
    "",
    "## Warnings",
    "",
    ...issueList(assessment.warnings),
    "",
    "## Endpoint and event mapping plan",
    "",
    ...assessment.endpointMappings.flatMap((endpoint) => [
      `### ${markdownText(endpoint.sourceEndpointId)}`,
      "",
      `Target reference: \`${markdownText(endpoint.targetReference)}\``,
      "",
      ...(endpoint.events.length === 0
        ? ["- No exported event mappings."]
        : endpoint.events.map(
            (event) =>
              `- ${markdownText(event.sourceEvent)}: **${event.status}**${
                event.canonicalEventId === undefined
                  ? ""
                  : ` → ${markdownText(event.canonicalEventId)}`
              }`,
          )),
      "",
    ]),
    "## Capability parity",
    "",
    "| Operation | Required | Status | Reason |",
    "| --- | --- | --- | --- |",
    ...assessment.capabilityParity.map(
      (item) =>
        `| ${markdownText(item.operation)} | ${item.required ? "yes" : "no"} | ${markdownText(item.status)} | ${markdownText(item.sourceReason)} |`,
    ),
    "",
    "## Signing and security gaps",
    "",
    ...issueList(assessment.signingSecurityGaps),
    "",
    "## Retention and observability gaps",
    "",
    ...issueList(assessment.retentionObservabilityGaps),
    "",
    "## Rollback prerequisites",
    "",
    ...assessment.rollbackPrerequisites.map(
      (item) =>
        `- **${markdownText(item.status)} — ${markdownText(item.code)}**: ${markdownText(item.message)}`,
    ),
    "",
    "## Migration phases",
    "",
    ...assessment.migrationPhases.flatMap((phase) => [
      `### ${markdownText(phase.name)}`,
      "",
      ...phase.steps.map((step) => `- ${markdownText(step)}`),
      "",
    ]),
  ];
  return enforceBoundedOutput(
    `${lines.join("\n").trimEnd()}\n`,
    options,
    "Markdown",
  );
}
