// SPDX-License-Identifier: Apache-2.0

import { diffContracts, type DiffOptions } from "@webhook-portal/contract-core";
import type {
  CanonicalContract,
  CompatibilityChange,
  CompatibilityChangeKind,
  CompatibilityResult,
  CompatibilityStatus,
  ParserIdentity,
  Sha256Checksum,
  SourceFormat,
} from "@webhook-portal/canonical-model";

import {
  resolveNarrative,
  type ReportPriority,
  type ReportSeverity,
} from "./narratives.js";
import { computeReportChecksum } from "./verification.js";

export {
  SEVERITY_PRIORITY_MATRIX as COMPATIBILITY_SEVERITY_PRIORITY_MATRIX,
  type ReportPriority,
  type ReportSeverity,
} from "./narratives.js";

export const COMPATIBILITY_REPORT_FORMAT =
  "webhook-portal.compatibility-report" as const;
export const COMPATIBILITY_REPORT_VERSION = "1.0.0" as const;
export const COMPATIBILITY_REPORT_GENERATOR = Object.freeze({
  name: "@webhook-portal/compatibility-report",
  version: "0.1.0",
});

export type ReportView = "combined" | "consumer" | "producer";
export type ContractDiff = CompatibilityResult;
export type ReportDecision =
  "approve-documentation" | "block" | "proceed-with-verification" | "review";

export interface CompatibilityReportLimits {
  readonly maxChanges?: number;
  readonly maxGroups?: number;
  readonly maxSteps?: number;
  readonly maxTextCodePoints?: number;
}

export interface CompatibilityReportOptions {
  readonly diff?: CompatibilityResult;
  readonly diffOptions?: DiffOptions;
  readonly limits?: CompatibilityReportLimits;
  readonly view?: ReportView;
}

export interface ReportEvidence {
  readonly canonicalPointer: string;
  readonly changeCode: string;
  readonly eventId?: string;
  readonly nextCanonicalChecksum: string;
  readonly previousCanonicalChecksum: string;
}

export interface ReportChange {
  readonly code: string;
  readonly evidence: ReportEvidence;
  readonly finding: string;
  readonly kind: CompatibilityChangeKind;
  readonly priority: ReportPriority;
  readonly severity: ReportSeverity;
  readonly status: CompatibilityStatus;
  readonly title: string;
  readonly version?: string;
}

export interface ReportChangeGroup {
  readonly changes: readonly ReportChange[];
  readonly eventId?: string;
  readonly eventName?: string;
  readonly scope: "contract" | "event";
}

export interface ReportImpact {
  readonly status: CompatibilityStatus;
  readonly summary: string;
}

export interface ReportStep {
  readonly changeCode: string;
  readonly instruction: string;
  readonly priority: ReportPriority;
}

export interface RolloutGuidance {
  readonly dualVersion: {
    readonly applicable: boolean;
    readonly guidance: string;
  };
  readonly rollback: {
    readonly required: boolean;
    readonly guidance: string;
  };
  readonly testing: {
    readonly required: boolean;
    readonly guidance: string;
  };
}

export interface ReportLineageEntry {
  readonly canonicalChecksum: Sha256Checksum;
  readonly parser: ParserIdentity;
  readonly sourceChecksum: Sha256Checksum;
  readonly sourceFormat: SourceFormat;
  readonly specificationVersion: string;
}

export interface CompatibilityReport {
  readonly consumerImpact: ReportImpact;
  readonly decision: ReportDecision;
  readonly executiveSummary: {
    readonly counts: Readonly<Record<CompatibilityStatus, number>>;
    readonly headline: string;
    readonly statement: string;
  };
  readonly format: typeof COMPATIBILITY_REPORT_FORMAT;
  readonly formatVersion: typeof COMPATIBILITY_REPORT_VERSION;
  readonly generatedBy: typeof COMPATIBILITY_REPORT_GENERATOR;
  readonly groups: readonly ReportChangeGroup[];
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly value: string;
  };
  readonly lineage: {
    readonly diff: {
      readonly source: "contract-core" | "provided";
    };
    readonly next: ReportLineageEntry;
    readonly previous: ReportLineageEntry;
  };
  readonly producerImpact: ReportImpact;
  readonly remediation: {
    readonly recommended: readonly ReportStep[];
    readonly required: readonly ReportStep[];
  };
  readonly rollout: RolloutGuidance;
  readonly status: CompatibilityStatus;
  readonly uncertainty: {
    readonly disclosures: readonly string[];
    readonly requiresReview: boolean;
  };
  readonly view: ReportView;
}

interface ResolvedLimits {
  readonly maxChanges: number;
  readonly maxGroups: number;
  readonly maxSteps: number;
  readonly maxTextCodePoints: number;
}

const defaultLimits: ResolvedLimits = Object.freeze({
  maxChanges: 500,
  maxGroups: 100,
  maxSteps: 50,
  maxTextCodePoints: 240,
});

const rank: Readonly<Record<CompatibilityStatus, number>> = Object.freeze({
  "docs-only": 0,
  compatible: 1,
  unknown: 2,
  breaking: 3,
});

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function limitsFrom(
  options: CompatibilityReportLimits | undefined,
): ResolvedLimits {
  return {
    maxChanges: boundedInteger(
      options?.maxChanges,
      defaultLimits.maxChanges,
      1_000,
      "maxChanges",
    ),
    maxGroups: boundedInteger(
      options?.maxGroups,
      defaultLimits.maxGroups,
      200,
      "maxGroups",
    ),
    maxSteps: boundedInteger(
      options?.maxSteps,
      defaultLimits.maxSteps,
      100,
      "maxSteps",
    ),
    maxTextCodePoints: boundedInteger(
      options?.maxTextCodePoints,
      defaultLimits.maxTextCodePoints,
      1_000,
      "maxTextCodePoints",
    ),
  };
}

function truncate(value: string, maximum: number): string {
  const points = [...value];
  return points.length <= maximum
    ? value
    : `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function checksumEqual(left: Sha256Checksum, right: Sha256Checksum): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function assertDiffLineage(
  previous: CanonicalContract,
  next: CanonicalContract,
  diff: CompatibilityResult,
): void {
  if (!checksumEqual(previous.checksum, diff.previousChecksum)) {
    throw new Error("Diff previous checksum does not match previous contract");
  }
  if (!checksumEqual(next.checksum, diff.nextChecksum)) {
    throw new Error("Diff next checksum does not match next contract");
  }
}

function assertChecksum(checksum: Sha256Checksum, name: string): void {
  if (
    checksum.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/u.test(checksum.value)
  ) {
    throw new Error(`${name} must be a lowercase SHA-256 checksum`);
  }
}

function strongest(
  statuses: readonly CompatibilityStatus[],
): CompatibilityStatus {
  return statuses.reduce<CompatibilityStatus>(
    (result, status) => (rank[status] > rank[result] ? status : result),
    "docs-only",
  );
}

function aggregateStatus(
  changes: readonly CompatibilityChange[],
): CompatibilityStatus {
  if (changes.length === 0) return "docs-only";
  return strongest(changes.map(({ status }) => status));
}

function eventLookup(
  previous: CanonicalContract,
  next: CanonicalContract,
): ReadonlyMap<string, string> {
  const entries = [...previous.eventTypes, ...next.eventTypes]
    .map((event) => [event.id, event.externalName] as const)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return new Map(entries);
}

function decodePointerToken(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function versionFrom(pointer: string): string | undefined {
  const match = /\/versions\/([^/]+)/u.exec(pointer);
  return match?.[1] === undefined ? undefined : decodePointerToken(match[1]);
}

function sortedChanges(
  changes: readonly CompatibilityChange[],
): readonly CompatibilityChange[] {
  return [...changes].sort((left, right) => {
    const leftKey = `${left.eventId ?? ""}\u0000${left.pointer}\u0000${left.code}\u0000${left.status}\u0000${left.kind}`;
    const rightKey = `${right.eventId ?? ""}\u0000${right.pointer}\u0000${right.code}\u0000${right.status}\u0000${right.kind}`;
    return compareCodeUnits(leftKey, rightKey);
  });
}

function reportChange(
  change: CompatibilityChange,
  previous: CanonicalContract,
  next: CanonicalContract,
  maximumTextLength: number,
): {
  readonly change: ReportChange;
  readonly disclosure?: string;
} {
  const narrative = resolveNarrative(change.code, change.status, change.kind);
  const version = versionFrom(change.pointer);
  const code = truncate(change.code, maximumTextLength);
  const pointer = truncate(change.pointer, maximumTextLength);
  const eventId =
    change.eventId === undefined
      ? undefined
      : truncate(change.eventId, maximumTextLength);
  return {
    change: {
      code,
      evidence: {
        canonicalPointer: pointer,
        changeCode: code,
        ...(eventId === undefined ? {} : { eventId }),
        nextCanonicalChecksum: next.checksum.value,
        previousCanonicalChecksum: previous.checksum.value,
      },
      finding: narrative.finding,
      kind: change.kind,
      priority: narrative.priority,
      severity: narrative.severity,
      status: narrative.effectiveStatus,
      title: narrative.title,
      ...(version === undefined
        ? {}
        : { version: truncate(version, maximumTextLength) }),
    },
    ...(!narrative.known
      ? { disclosure: `Unknown diff code ${code} requires review.` }
      : narrative.statusMismatch
        ? {
            disclosure: `Diff code ${code} has an unexpected ${change.status} status and requires review.`,
          }
        : {}),
  };
}

function stepFor(change: ReportChange): ReportStep {
  const instruction =
    change.status === "breaking"
      ? `Resolve ${change.code} at ${change.evidence.canonicalPointer || "/"} before rollout.`
      : change.status === "unknown"
        ? `Review ${change.code} at ${change.evidence.canonicalPointer || "/"} and record contract-test evidence.`
        : change.status === "compatible"
          ? `Test ${change.code} at ${change.evidence.canonicalPointer || "/"} against producer and representative consumer fixtures.`
          : `Review documentation affected by ${change.code} at ${change.evidence.canonicalPointer || "/"}.`;
  return {
    changeCode: change.code,
    instruction,
    priority: change.priority,
  };
}

function uniqueSteps(
  changes: readonly ReportChange[],
  statuses: ReadonlySet<CompatibilityStatus>,
  maximum: number,
): readonly ReportStep[] {
  const seen = new Set<string>();
  const steps: ReportStep[] = [];
  for (const change of changes) {
    if (!statuses.has(change.status)) continue;
    const step = stepFor(change);
    const key = `${step.changeCode}\u0000${step.instruction}`;
    if (!seen.has(key)) {
      seen.add(key);
      steps.push(step);
    }
    if (steps.length >= maximum) break;
  }
  return steps;
}

function decisionFor(status: CompatibilityStatus): ReportDecision {
  switch (status) {
    case "breaking":
      return "block";
    case "unknown":
      return "review";
    case "compatible":
      return "proceed-with-verification";
    case "docs-only":
      return "approve-documentation";
  }
}

function headlineFor(
  status: CompatibilityStatus,
  counts: Readonly<Record<CompatibilityStatus, number>>,
): string {
  switch (status) {
    case "breaking":
      return `Compatibility blocked: ${counts.breaking} breaking change(s).`;
    case "unknown":
      return `Compatibility requires review: ${counts.unknown} unknown change(s).`;
    case "compatible":
      return `No breaking or unknown changes reported; ${counts.compatible} compatible change(s) require verification.`;
    case "docs-only":
      return `${counts["docs-only"]} documentation-only change(s) reported.`;
  }
}

function impactFor(
  role: "consumer" | "producer",
  status: CompatibilityStatus,
): ReportImpact {
  const prefix =
    role === "consumer"
      ? "This report does not assert actual consumer usage."
      : "This report evaluates the producer contract, not deployment state.";
  const suffix =
    status === "breaking"
      ? " Breaking changes require remediation before rollout."
      : status === "unknown"
        ? " Unknown changes require review before rollout."
        : status === "compatible"
          ? " Compatible changes still require contract testing."
          : " Only documentation effects were classified.";
  return { status, summary: `${prefix}${suffix}` };
}

function lineage(
  contract: CanonicalContract,
  maximumTextLength: number,
): ReportLineageEntry {
  return {
    canonicalChecksum: contract.checksum,
    parser: {
      name: truncate(contract.source.parser.name, maximumTextLength),
      version: truncate(contract.source.parser.version, maximumTextLength),
    },
    sourceChecksum: contract.source.sourceChecksum,
    sourceFormat: contract.source.format,
    specificationVersion: truncate(
      contract.source.specificationVersion,
      maximumTextLength,
    ),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
  }
  return value;
}

export function createCompatibilityReport(
  previous: CanonicalContract,
  next: CanonicalContract,
  options: CompatibilityReportOptions = {},
): CompatibilityReport {
  const limits = limitsFrom(options.limits);
  assertChecksum(previous.checksum, "Previous canonical checksum");
  assertChecksum(next.checksum, "Next canonical checksum");
  assertChecksum(previous.source.sourceChecksum, "Previous source checksum");
  assertChecksum(next.source.sourceChecksum, "Next source checksum");
  const diff =
    options.diff ?? diffContracts(previous, next, options.diffOptions);
  assertDiffLineage(previous, next, diff);

  const disclosures: string[] = [];
  const rawAggregate = aggregateStatus(diff.changes);
  if (rawAggregate !== diff.status) {
    disclosures.push(
      `The diff summary status ${diff.status} does not match its change statuses and requires review.`,
    );
  }

  const limited = sortedChanges(diff.changes).slice(0, limits.maxChanges);
  if (limited.length < diff.changes.length) {
    disclosures.push(
      `The report includes ${limited.length} of ${diff.changes.length} diff changes; omitted changes require review.`,
    );
  }

  const converted = limited.map((change) =>
    reportChange(change, previous, next, limits.maxTextCodePoints),
  );
  for (const item of converted) {
    if (item.disclosure !== undefined) disclosures.push(item.disclosure);
  }

  const names = eventLookup(previous, next);
  const grouped = new Map<string, ReportChange[]>();
  for (const { change } of converted) {
    const key = change.evidence.eventId ?? "";
    const group = grouped.get(key) ?? [];
    group.push(change);
    grouped.set(key, group);
  }
  const groupKeys = [...grouped.keys()].sort(compareCodeUnits);
  const includedGroupKeys = groupKeys.slice(0, limits.maxGroups);
  if (includedGroupKeys.length < groupKeys.length) {
    disclosures.push(
      `The report includes ${includedGroupKeys.length} of ${groupKeys.length} change groups; omitted groups require review.`,
    );
  }
  const groups: ReportChangeGroup[] = includedGroupKeys.map((eventId) => ({
    changes: grouped.get(eventId) ?? [],
    ...(eventId === ""
      ? { scope: "contract" as const }
      : {
          eventId,
          eventName: truncate(
            names.get(eventId) ?? eventId,
            limits.maxTextCodePoints,
          ),
          scope: "event" as const,
        }),
  }));
  const includedChanges = groups.flatMap(({ changes }) => changes);
  const bounded =
    limited.length < diff.changes.length ||
    includedGroupKeys.length < groupKeys.length;
  const effectiveAggregate = strongest([
    diff.status,
    rawAggregate,
    ...includedChanges.map(({ status }) => status),
    ...(bounded ? (["unknown"] as const) : []),
    ...(disclosures.some((item) => item.includes("requires review"))
      ? (["unknown"] as const)
      : []),
  ]);
  const counts: Record<CompatibilityStatus, number> = {
    breaking: 0,
    compatible: 0,
    "docs-only": 0,
    unknown: 0,
  };
  for (const change of includedChanges) counts[change.status] += 1;

  const required = uniqueSteps(
    includedChanges,
    new Set(["breaking", "unknown"]),
    limits.maxSteps,
  );
  const recommended = uniqueSteps(
    includedChanges,
    new Set(["compatible", "docs-only"]),
    limits.maxSteps,
  );
  const dualVersionApplicable = includedChanges.some(
    ({ code, status }) =>
      status === "breaking" &&
      (code.includes("REMOVED") ||
        code.includes("NARROWED") ||
        code.includes("SIGNATURE") ||
        code === "TYPE_CHANGED"),
  );
  const testingRequired = effectiveAggregate !== "docs-only";
  const rollbackRequired =
    effectiveAggregate === "breaking" || effectiveAggregate === "unknown";

  const unsigned: Omit<CompatibilityReport, "integrity"> = {
    consumerImpact: impactFor("consumer", effectiveAggregate),
    decision: decisionFor(effectiveAggregate),
    executiveSummary: {
      counts,
      headline: headlineFor(effectiveAggregate, counts),
      statement:
        "This deterministic report is derived only from canonical contract metadata and compatibility diff codes; it does not infer runtime behavior or consumer adoption.",
    },
    format: COMPATIBILITY_REPORT_FORMAT,
    formatVersion: COMPATIBILITY_REPORT_VERSION,
    generatedBy: COMPATIBILITY_REPORT_GENERATOR,
    groups,
    lineage: {
      diff: {
        source: options.diff === undefined ? "contract-core" : "provided",
      },
      next: lineage(next, limits.maxTextCodePoints),
      previous: lineage(previous, limits.maxTextCodePoints),
    },
    producerImpact: impactFor("producer", effectiveAggregate),
    remediation: { recommended, required },
    rollout: {
      dualVersion: {
        applicable: dualVersionApplicable,
        guidance: dualVersionApplicable
          ? "Keep the prior event/version available while the replacement is tested and consumers migrate."
          : "Dual-version operation is not indicated by the classified change codes.",
      },
      rollback: {
        required: rollbackRequired,
        guidance: rollbackRequired
          ? "Define and test a rollback to the previous canonical checksum before rollout."
          : "Retain the previous canonical checksum as the rollback reference.",
      },
      testing: {
        required: testingRequired,
        guidance: testingRequired
          ? "Run producer contract tests and representative consumer fixture tests before rollout."
          : "Validate rendered documentation and links.",
      },
    },
    status: effectiveAggregate,
    uncertainty: {
      disclosures,
      requiresReview:
        effectiveAggregate === "unknown" || disclosures.length > 0,
    },
    view: options.view ?? "combined",
  };
  const report: CompatibilityReport = {
    ...unsigned,
    integrity: {
      algorithm: "sha256",
      value: computeReportChecksum(unsigned),
    },
  };
  return deepFreeze(report);
}
