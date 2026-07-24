// SPDX-License-Identifier: Apache-2.0

import { type CanonicalEventType } from "@webhook-portal/canonical-model";

import type {
  ContractImportResult,
  ContractInput,
  ContractOptions,
  ContractValidationResult,
  ParsedContract,
} from "./api-types.js";
import { asyncApiEvents } from "./asyncapi-extraction.js";
import {
  canonicalContract,
  canonicalExport,
  mergeEvents,
  statusFor,
  validateCanonicalOutput,
  validateDeclaredSchemas,
  validateTopLevelCanonicalFields,
} from "./canonicalization.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { type ExtractionContext } from "./extraction-context.js";
import { resolveLimits } from "./limits.js";
import { openApiEvents } from "./openapi-extraction.js";
import { isParsedContract, parseContract } from "./parser.js";
import { type ReferenceContext } from "./refs.js";
import { createDocumentSchemaIndex } from "./schema-processing.js";
import { validateSourceDocument } from "./source-validation.js";

export { computeCanonicalChecksum } from "./canonicalization.js";

function processContract(
  input: ContractInput | ParsedContract,
  options: ContractOptions,
  includeCanonical: boolean,
): ContractImportResult {
  const limits = resolveLimits(options.limits);
  const parsed = isParsedContract(input)
    ? input
    : parseContract(input, options);
  const diagnostics = new DiagnosticCollector(limits.maxDiagnostics);
  diagnostics.addAll(parsed.diagnostics);

  let events: readonly CanonicalEventType[] = [];
  if (
    parsed.document !== undefined &&
    parsed.format !== undefined &&
    parsed.specificationVersion !== undefined
  ) {
    if (parsed.supported) {
      validateSourceDocument(
        parsed.document,
        parsed.format,
        parsed.specificationVersion,
        parsed.locations,
        diagnostics,
      );
      validateTopLevelCanonicalFields(parsed, diagnostics);
    }

    const references: ReferenceContext = {
      diagnostics,
      documentId: "local",
      limits,
      locations: parsed.locations,
      referenceBudget: { count: 0, exceeded: false, seen: new Set() },
      root: parsed.document,
      sourceFormat: parsed.format,
      specificationVersion: parsed.specificationVersion,
    };
    if (parsed.supported && !diagnostics.hasErrors()) {
      const validationBudget = { exhausted: false, used: 0 };
      const schemaIndex = createDocumentSchemaIndex(parsed.document, {
        diagnostics,
        limits,
        locations: parsed.locations,
        workBudget: validationBudget,
      });
      const extraction: ExtractionContext = {
        diagnostics,
        outputBudget: { bytes: 0, exhausted: false, nodes: 0 },
        parsed,
        references,
        schemaIndex,
        schemaRootIndexes: new WeakMap(),
        validationBudget,
        validateExamples: true,
      };
      validateDeclaredSchemas(parsed.document, parsed.format, extraction);
      const extracted = diagnostics.hasErrors()
        ? []
        : parsed.format === "openapi"
          ? openApiEvents(parsed.document, extraction)
          : asyncApiEvents(
              parsed.document,
              parsed.specificationVersion,
              extraction,
            );
      events = mergeEvents(extracted, extraction);
    }
  }

  let canonicalCandidate =
    parsed.supported && events.length > 0 && !diagnostics.hasErrors()
      ? canonicalContract(parsed, events, limits, diagnostics)
      : undefined;
  if (
    canonicalCandidate !== undefined &&
    !validateCanonicalOutput(canonicalCandidate, diagnostics)
  ) {
    canonicalCandidate = undefined;
  }
  const collected = diagnostics.toArray();
  const status = statusFor(collected, parsed.supported);
  const contract =
    includeCanonical && status !== "invalid" ? canonicalCandidate : undefined;
  return {
    diagnostics: collected,
    parsed,
    status,
    ...(contract === undefined
      ? {}
      : { contract, export: canonicalExport(parsed, contract) }),
  };
}

export function validateContract(
  input: ContractInput | ParsedContract,
  options: ContractOptions = {},
): ContractValidationResult {
  const result = processContract(input, options, false);
  return {
    diagnostics: result.diagnostics,
    parsed: result.parsed,
    status: result.status,
  };
}

export function importContract(
  input: ContractInput,
  options: ContractOptions = {},
): ContractImportResult {
  return processContract(input, options, true);
}

export function canonicalizeContract(
  input: ContractInput | ParsedContract,
  options: ContractOptions = {},
): ContractImportResult {
  return processContract(input, options, true);
}
