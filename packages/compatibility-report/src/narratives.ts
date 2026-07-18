// SPDX-License-Identifier: Apache-2.0

import type {
  CompatibilityChangeKind,
  CompatibilityStatus,
} from "@webhook-portal/canonical-model";

export type ReportSeverity = "critical" | "high" | "informational" | "low";
export type ReportPriority = "P0" | "P1" | "P2" | "P3";

interface NarrativeDefinition {
  readonly allowed: readonly CompatibilityStatus[];
  readonly title: string;
}

export const SEVERITY_PRIORITY_MATRIX: Readonly<
  Record<
    CompatibilityStatus,
    { readonly priority: ReportPriority; readonly severity: ReportSeverity }
  >
> = Object.freeze({
  breaking: { priority: "P0", severity: "critical" },
  unknown: { priority: "P1", severity: "high" },
  compatible: { priority: "P2", severity: "low" },
  "docs-only": { priority: "P3", severity: "informational" },
});

const definitions = {
  ADDITIONAL_PROPERTIES_ALLOWED: {
    allowed: ["compatible"],
    title: "Additional properties are now allowed",
  },
  ADDITIONAL_PROPERTIES_FORBIDDEN: {
    allowed: ["breaking"],
    title: "Additional properties are now forbidden",
  },
  ADDITIONAL_PROPERTIES_RESTRICTED: {
    allowed: ["breaking"],
    title: "Additional properties gained schema constraints",
  },
  ADDITIONAL_PROPERTIES_WIDENED: {
    allowed: ["compatible"],
    title: "Additional property constraints were relaxed",
  },
  ARRAY_ITEMS_CHANGED: {
    allowed: ["unknown"],
    title: "Array item compatibility is unknown",
  },
  BOOLEAN_SCHEMA_CHANGED: {
    allowed: ["breaking"],
    title: "A boolean schema changed incompatibly",
  },
  CONSTRAINT_NARROWED: {
    allowed: ["breaking"],
    title: "A schema constraint narrowed",
  },
  CONSTRAINT_WIDENED: {
    allowed: ["compatible"],
    title: "A schema constraint widened",
  },
  CONTRACT_DOCUMENTATION_CHANGED: {
    allowed: ["docs-only"],
    title: "Contract documentation changed",
  },
  CONTRACT_EXTENSIONS_CHANGED: {
    allowed: ["unknown"],
    title: "Contract extensions changed",
  },
  CONTRACT_SIGNATURE_PROFILE_CHANGED: {
    allowed: ["breaking"],
    title: "The contract signature profile changed",
  },
  DIFF_TRUNCATED: {
    allowed: ["breaking", "compatible", "docs-only", "unknown"],
    title: "The compatibility diff was truncated",
  },
  ENUM_CHANGED: {
    allowed: ["breaking"],
    title: "Enumeration values changed incompatibly",
  },
  ENUM_CONSTRAINT_CHANGED: {
    allowed: ["breaking", "compatible"],
    title: "Finite-value constraints changed",
  },
  ENUM_NARROWED: {
    allowed: ["breaking"],
    title: "Enumeration values narrowed",
  },
  ENUM_WIDENED: {
    allowed: ["compatible"],
    title: "Enumeration values widened",
  },
  EVENT_ADDED: {
    allowed: ["compatible"],
    title: "An event was added",
  },
  EVENT_DOCUMENTATION_CHANGED: {
    allowed: ["docs-only"],
    title: "Event documentation changed",
  },
  EVENT_EXTENSIONS_CHANGED: {
    allowed: ["unknown"],
    title: "Event extensions changed",
  },
  EVENT_ID_CHANGED: {
    allowed: ["unknown"],
    title: "A stable event identifier changed",
  },
  EVENT_REMOVED: {
    allowed: ["breaking"],
    title: "An event was removed",
  },
  EVENT_SCHEMA_UNSUPPORTED: {
    allowed: ["unknown"],
    title: "An added event uses unsupported schema features",
  },
  EVENT_VERSION_ADDED: {
    allowed: ["compatible"],
    title: "An event version was added",
  },
  EVENT_VERSION_DOCUMENTATION_CHANGED: {
    allowed: ["docs-only"],
    title: "Event version documentation changed",
  },
  EVENT_VERSION_EXTENSIONS_CHANGED: {
    allowed: ["unknown"],
    title: "Event version extensions changed",
  },
  EVENT_VERSION_ID_CHANGED: {
    allowed: ["unknown"],
    title: "A stable event version identifier changed",
  },
  EVENT_VERSION_REMOVED: {
    allowed: ["breaking"],
    title: "An event version was removed",
  },
  FINITE_VALUE_EXCLUDED: {
    allowed: ["breaking"],
    title: "A previously accepted finite value was excluded",
  },
  FINITE_VALUE_INCLUSION_UNKNOWN: {
    allowed: ["unknown"],
    title: "Finite-value inclusion is unknown",
  },
  MAXIMUM_NARROWED: {
    allowed: ["breaking"],
    title: "A maximum bound narrowed",
  },
  MAXIMUM_WIDENED: {
    allowed: ["compatible"],
    title: "A maximum bound widened",
  },
  MINIMUM_NARROWED: {
    allowed: ["breaking"],
    title: "A minimum bound narrowed",
  },
  MINIMUM_WIDENED: {
    allowed: ["compatible"],
    title: "A minimum bound widened",
  },
  OPTIONAL_PROPERTY_ADDED: {
    allowed: ["compatible"],
    title: "An optional property was added",
  },
  OPTIONAL_PROPERTY_CONFLICT: {
    allowed: ["breaking"],
    title: "An optional property conflicts with prior acceptance",
  },
  OPTIONAL_PROPERTY_INCLUSION_UNKNOWN: {
    allowed: ["unknown"],
    title: "Optional property inclusion is unknown",
  },
  PROPERTY_BECAME_OPTIONAL: {
    allowed: ["compatible"],
    title: "A property became optional",
  },
  PROPERTY_BECAME_REQUIRED: {
    allowed: ["breaking"],
    title: "A property became required",
  },
  PROPERTY_CONSTRAINT_REMOVED: {
    allowed: ["compatible"],
    title: "A property constraint was removed",
  },
  PROPERTY_REMOVAL_INCLUSION_UNKNOWN: {
    allowed: ["unknown"],
    title: "Property removal compatibility is unknown",
  },
  PROPERTY_REMOVED: {
    allowed: ["breaking"],
    title: "A property was removed",
  },
  PROPERTY_SCHEMA_UNSUPPORTED: {
    allowed: ["unknown"],
    title: "A property uses unsupported schema features",
  },
  REQUIRED_PROPERTY_ADDED: {
    allowed: ["breaking"],
    title: "A required property was added",
  },
  REQUIRED_PROPERTY_REMOVED: {
    allowed: ["compatible"],
    title: "A required property was removed",
  },
  SCHEMA_CHANGE_UNKNOWN: {
    allowed: ["unknown"],
    title: "A schema change is unclassified",
  },
  SCHEMA_DIALECT_CHANGED: {
    allowed: ["unknown"],
    title: "The schema dialect changed",
  },
  SCHEMA_DOCUMENTATION_CHANGED: {
    allowed: ["docs-only"],
    title: "Schema documentation changed",
  },
  SCHEMA_NARROWED: {
    allowed: ["breaking"],
    title: "A schema narrowed",
  },
  SCHEMA_WIDENED: {
    allowed: ["compatible"],
    title: "A schema widened",
  },
  SIGNATURE_PROFILE_CHANGED: {
    allowed: ["breaking"],
    title: "An event signature profile changed",
  },
  SOURCE_SPECIFICATION_CHANGED: {
    allowed: ["unknown"],
    title: "The source specification changed",
  },
  TYPE_CHANGED: {
    allowed: ["breaking"],
    title: "Accepted JSON types changed incompatibly",
  },
  TYPE_CLASSIFICATION_UNKNOWN: {
    allowed: ["unknown"],
    title: "Type compatibility is unknown",
  },
  TYPE_CONSTRAINT_ADDED: {
    allowed: ["breaking"],
    title: "A type constraint was added",
  },
  TYPE_NARROWED: {
    allowed: ["breaking"],
    title: "Accepted JSON types narrowed",
  },
  TYPE_WIDENED: {
    allowed: ["compatible"],
    title: "Accepted JSON types widened",
  },
  UNCLASSIFIED_SCHEMA_KEYWORD_CHANGED: {
    allowed: ["unknown"],
    title: "An unclassified schema keyword changed",
  },
  UNION_CHANGE_UNKNOWN: {
    allowed: ["unknown"],
    title: "Union compatibility is unknown",
  },
  UNSUPPORTED_SCHEMA_DIFF: {
    allowed: ["unknown"],
    title: "Schema compatibility uses unsupported features",
  },
  VERSION_COMPARISON_AMBIGUOUS: {
    allowed: ["unknown"],
    title: "Event version comparison is ambiguous",
  },
} as const satisfies Readonly<Record<string, NarrativeDefinition>>;

export interface ResolvedNarrative {
  readonly effectiveStatus: CompatibilityStatus;
  readonly finding: string;
  readonly known: boolean;
  readonly priority: ReportPriority;
  readonly severity: ReportSeverity;
  readonly statusMismatch: boolean;
  readonly title: string;
}

function findingFor(
  status: CompatibilityStatus,
  kind: CompatibilityChangeKind,
): string {
  switch (status) {
    case "breaking":
      return `The diff classifies this ${kind} change as breaking; rollout must remain blocked until it is remediated or explicitly accepted.`;
    case "unknown":
      return `The diff cannot safely classify this ${kind} change; human review and contract tests are required.`;
    case "compatible":
      return `The diff classifies this ${kind} change as compatible, but downstream behavior still requires verification.`;
    case "docs-only":
      return `The diff classifies this ${kind} change as documentation-only.`;
  }
}

export function resolveNarrative(
  code: string,
  status: CompatibilityStatus,
  kind: CompatibilityChangeKind,
): ResolvedNarrative {
  const definition = Object.hasOwn(definitions, code)
    ? definitions[code as keyof typeof definitions]
    : undefined;
  const statusMismatch =
    definition !== undefined &&
    !(definition.allowed as readonly CompatibilityStatus[]).includes(status);
  const effectiveStatus =
    definition === undefined || statusMismatch ? "unknown" : status;
  const matrix = SEVERITY_PRIORITY_MATRIX[effectiveStatus];
  return {
    effectiveStatus,
    finding:
      definition === undefined
        ? "This change code is not recognized by this report version; human review and contract tests are required."
        : statusMismatch
          ? "This change code has an unexpected status for this report version; human review and contract tests are required."
          : findingFor(status, kind),
    known: definition !== undefined,
    priority: matrix.priority,
    severity: matrix.severity,
    statusMismatch,
    title: definition?.title ?? "Unrecognized compatibility change",
  };
}

export function matrixFor(status: CompatibilityStatus): {
  readonly priority: ReportPriority;
  readonly severity: ReportSeverity;
} {
  return SEVERITY_PRIORITY_MATRIX[status];
}
