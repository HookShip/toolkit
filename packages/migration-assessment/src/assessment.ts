// SPDX-License-Identifier: Apache-2.0

import type {
  AssessmentDiagnostic,
  AssessmentInput,
  MigrationAssessment,
} from "./types.js";
import {
  assessmentInputDiagnostics,
  capabilityParity,
  checksumInventory,
  mappingPlan,
  migrationPhases,
  operationalGaps,
  policyLimitIssues,
  readiness,
  rollbackPrerequisites,
  securityGaps,
  sortedIssues,
} from "./assessment-rules.js";
export { canonicalJson, checksumInventory } from "./assessment-rules.js";
import { parseInventoryExportJson } from "./import.js";
import { MIGRATION_ASSESSMENT_VERSION } from "./types.js";

export class AssessmentInputError extends Error {
  readonly diagnostics: readonly AssessmentDiagnostic[];

  constructor(diagnostics: readonly AssessmentDiagnostic[]) {
    super("Migration assessment input is invalid.");
    this.name = "AssessmentInputError";
    this.diagnostics = diagnostics;
  }
}

export function assessMigration(input: AssessmentInput): MigrationAssessment {
  const inputDiagnostics = assessmentInputDiagnostics(input);
  if (inputDiagnostics.length > 0) {
    throw new AssessmentInputError(inputDiagnostics);
  }
  let serializedInventory: string;
  try {
    serializedInventory = JSON.stringify(input.inventory);
  } catch {
    throw new AssessmentInputError([
      {
        code: "INVALID_INVENTORY",
        message: "inventory must be finite acyclic JSON.",
        pointer: "/inventory",
        severity: "error",
      },
    ]);
  }
  const validated = parseInventoryExportJson(serializedInventory);
  if (!validated.ok || validated.inventory === undefined) {
    throw new AssessmentInputError(validated.diagnostics);
  }
  const normalizedInput = { ...input, inventory: validated.inventory };
  const mapping = mappingPlan(normalizedInput);
  const parity = capabilityParity(normalizedInput);
  const security = securityGaps(normalizedInput);
  const operations = operationalGaps(normalizedInput);
  const limits = policyLimitIssues(normalizedInput);
  const rollback = rollbackPrerequisites(normalizedInput);
  const rollbackBlockers = rollback
    .filter((item) => item.status === "unmet")
    .map((item) => ({
      code: `ROLLBACK_${item.code}`,
      message: item.message,
    }));
  const blockers = sortedIssues([
    ...mapping.issues,
    ...parity.blockers,
    ...security.blockers,
    ...limits,
    ...rollbackBlockers,
  ]);
  const warnings = sortedIssues([
    ...parity.warnings,
    ...security.warnings,
    ...operations,
  ]);
  const subscriptions = normalizedInput.inventory.endpoints.reduce(
    (total, endpoint) => total + (endpoint.subscriptions?.length ?? 0),
    0,
  );
  return {
    assessmentVersion: MIGRATION_ASSESSMENT_VERSION,
    blockers,
    capabilityParity: parity.items,
    counts: {
      destinations: normalizedInput.inventory.destinations.length,
      endpoints: normalizedInput.inventory.endpoints.length,
      events: normalizedInput.contract.eventTypes.length,
      pausedEndpoints: normalizedInput.inventory.endpoints.filter(
        (endpoint) =>
          endpoint.state === "paused" || endpoint.state === "disabled",
      ).length,
      subscriptions,
    },
    endpointMappings: mapping.mappings,
    inventoryChecksum: checksumInventory(normalizedInput.inventory),
    migrationPhases,
    provider: normalizedInput.inventory.provider,
    readiness: readiness(
      mapping.mappings,
      parity.items,
      security.gaps,
      operations,
      rollback,
      blockers,
    ),
    retentionObservabilityGaps: operations,
    rollbackPrerequisites: rollback,
    signingSecurityGaps: security.gaps,
    targetAdapter: {
      id: normalizedInput.capabilities.adapter.id,
      name: normalizedInput.capabilities.adapter.name,
      version: normalizedInput.capabilities.adapter.version,
    },
    unmappedOrAmbiguous: mapping.issues,
    warnings,
  };
}
