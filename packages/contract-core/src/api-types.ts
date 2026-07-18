// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalContract,
  CanonicalContractExport,
  CompatibilityResult,
  ContractDiagnostic,
  ContractImportStatus,
  JsonObject,
  JsonSchema,
  JsonValue,
  Sha256Checksum,
  SourceFormat,
  SourceMediaType,
  SourceRange,
} from "@webhook-portal/canonical-model";
import { PARSED_CONTRACT_BRAND } from "./parsed-brand.js";

export type ContractInput = JsonObject | string;
export type InputSyntax = "json" | "yaml";

export interface ContractLimits {
  readonly maxAliases: number;
  readonly maxDepth: number;
  readonly maxDiagnostics: number;
  readonly maxEvents: number;
  readonly maxExamplesPerEvent: number;
  readonly maxInputBytes: number;
  readonly maxNodes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputNodes: number;
  readonly maxPropertiesPerObject: number;
  readonly maxReferences: number;
  readonly maxStringBytes: number;
  readonly maxValidationOperations: number;
}

/**
 * Import configuration. Contract references are local-only; external and
 * relative references are always rejected by the MVP.
 */
export interface ContractOptions {
  readonly formatHint?: InputSyntax;
  readonly limits?: Partial<ContractLimits>;
  /** Source identity metadata only; contract-core never fetches this URI. */
  readonly sourceUri?: string;
}

export interface ParsedContract {
  readonly diagnostics: readonly ContractDiagnostic[];
  readonly document?: JsonObject;
  readonly format?: SourceFormat;
  readonly [PARSED_CONTRACT_BRAND]: true;
  readonly locations: Readonly<Record<string, SourceRange>>;
  readonly mediaType?: SourceMediaType;
  readonly ok: boolean;
  readonly original: ContractInput;
  readonly sourceChecksum?: Sha256Checksum;
  readonly sourceUri?: string;
  readonly specificationVersion?: string;
  readonly supported: boolean;
  readonly syntax?: InputSyntax;
}

export interface ContractValidationResult {
  readonly diagnostics: readonly ContractDiagnostic[];
  readonly parsed: ParsedContract;
  readonly status: ContractImportStatus;
}

export interface ContractImportResult extends ContractValidationResult {
  readonly contract?: CanonicalContract;
  readonly export?: CanonicalContractExport;
}

export interface DiffOptions {
  readonly maxChanges?: number;
}

export interface FixtureGenerationOptions {
  /** Include optional object properties in the generated example. */
  readonly includeOptionalProperties?: boolean;
  /** Maximum generated array length. */
  readonly maxArrayItems?: number;
  /** Maximum recursive schema depth. */
  readonly maxDepth?: number;
  /** Maximum Unicode code-point length of any fixture string. */
  readonly maxStringLength?: number;
  /** Maximum approximate serialized fixture size. */
  readonly maxOutputBytes?: number;
  /** Maximum number of values and containers in the fixture. */
  readonly maxOutputNodes?: number;
}

export type GenerationStatus = "generated" | "partial" | "unsupported";

export interface FixtureGenerationResult {
  readonly diagnostics: readonly ContractDiagnostic[];
  readonly status: GenerationStatus;
  readonly value?: JsonValue;
}

export interface TypeGenerationOptions {
  readonly exportType?: boolean;
  readonly maxDepth?: number;
  readonly typeName?: string;
}

export interface TypeGenerationResult {
  readonly code: string;
  readonly diagnostics: readonly ContractDiagnostic[];
  readonly status: GenerationStatus;
  readonly typeName: string;
}

export interface ContractCore {
  readonly canonicalize: (
    input: ContractInput | ParsedContract,
    options?: ContractOptions,
  ) => ContractImportResult;
  readonly checksum: (contract: CanonicalContract) => Sha256Checksum;
  readonly diff: (
    previous: CanonicalContract,
    next: CanonicalContract,
    options?: DiffOptions,
  ) => CompatibilityResult;
  readonly fixtures: (
    schema: JsonSchema,
    options?: FixtureGenerationOptions,
  ) => FixtureGenerationResult;
  readonly parse: (
    input: ContractInput,
    options?: ContractOptions,
  ) => ParsedContract;
  readonly types: (
    schema: JsonSchema,
    options?: TypeGenerationOptions,
  ) => TypeGenerationResult;
  readonly validate: (
    input: ContractInput | ParsedContract,
    options?: ContractOptions,
  ) => ContractValidationResult;
}
