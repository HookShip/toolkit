// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonSchema, JsonValue } from "./json.js";

export const CANONICAL_MODEL_VERSION = "1.0.0" as const;
export const CANONICAL_SCHEMA_VERSION = "2026-07-01" as const;
export const CANONICAL_SCHEMA_ID =
  "https://webhook-portal.dev/schemas/canonical-contract/2026-07-01" as const;
export const CANONICAL_EXPORT_FORMAT =
  "webhook-portal.canonical-contract" as const;
export const CANONICAL_EXPORT_VERSION = "1.0.0" as const;
export const CANONICAL_EXPORT_SCHEMA_ID =
  "https://webhook-portal.dev/schemas/canonical-contract-export/2026-07-01" as const;
export const JSON_SCHEMA_2020_12_DIALECT =
  "https://json-schema.org/draft/2020-12/schema" as const;
export const JSON_SCHEMA_DRAFT_07_DIALECT =
  "http://json-schema.org/draft-07/schema#" as const;
export const OPENAPI_3_1_BASE_DIALECT =
  "https://spec.openapis.org/oas/3.1/dialect/base" as const;

export type SourceFormat = "asyncapi" | "openapi";
export type SourceMediaType =
  "application/json" | "application/yaml" | "text/yaml";

export interface SourceLocation {
  readonly column: number;
  readonly line: number;
  readonly offset?: number;
}

export interface SourceRange {
  readonly end?: SourceLocation;
  readonly start: SourceLocation;
}

export interface SourcePointer {
  readonly location?: SourceRange;
  readonly pointer: string;
}

export interface Sha256Checksum {
  readonly algorithm: "sha256";
  readonly value: string;
}

export interface ParserIdentity {
  readonly name: string;
  readonly version: string;
}

export interface ContractSourceMetadata {
  readonly extensions?: JsonObject;
  readonly format: SourceFormat;
  readonly mediaType: SourceMediaType;
  readonly parser: ParserIdentity;
  readonly sourceChecksum: Sha256Checksum;
  readonly sourceUri?: string;
  readonly specificationVersion: string;
}

export interface CanonicalSchema {
  readonly checksum: Sha256Checksum;
  readonly dialect: string;
  readonly source?: SourcePointer;
  readonly value: JsonSchema;
}

export interface CanonicalExample {
  readonly description?: string;
  readonly name: string;
  readonly source?: SourcePointer;
  readonly summary?: string;
  readonly value: JsonValue;
}

export interface DeprecationMetadata {
  readonly deprecated: boolean;
  readonly replacement?: string;
  readonly sunsetAt?: string;
}

export interface SignatureHeader {
  readonly name: string;
  readonly required: boolean;
}

export interface SignatureProfile {
  readonly algorithms?: readonly string[];
  readonly extensions?: JsonObject;
  readonly headers?: readonly SignatureHeader[];
  readonly name: string;
  readonly version?: string;
}

export interface CanonicalEventVersion {
  readonly deprecation?: DeprecationMetadata;
  readonly description?: string;
  readonly examples: readonly CanonicalExample[];
  readonly extensions?: JsonObject;
  readonly id: string;
  readonly publicVersion: string;
  readonly schema: CanonicalSchema;
  readonly signatureProfile?: SignatureProfile;
  readonly source: SourcePointer;
  readonly title?: string;
}

export interface CanonicalEventType {
  readonly description?: string;
  readonly extensions?: JsonObject;
  readonly externalName: string;
  readonly id: string;
  readonly title?: string;
  readonly versions: readonly CanonicalEventVersion[];
}

export interface CanonicalContractContent {
  readonly $schema: typeof CANONICAL_SCHEMA_ID;
  readonly eventTypes: readonly CanonicalEventType[];
  readonly extensions?: JsonObject;
  readonly id: string;
  readonly modelVersion: typeof CANONICAL_MODEL_VERSION;
  readonly signatureProfile?: SignatureProfile;
  readonly source: ContractSourceMetadata;
  readonly title?: string;
  readonly version?: string;
}

export interface CanonicalContract extends CanonicalContractContent {
  readonly checksum: Sha256Checksum;
}

export type ContractImportStatus = "invalid" | "partial" | "valid";

export type DiagnosticSeverity = "error" | "fatal" | "info" | "warning";

export interface ContractDiagnostic {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
  readonly pointer?: string;
  readonly severity: DiagnosticSeverity;
  readonly source?: SourceRange;
}

export type CompatibilityStatus =
  "breaking" | "compatible" | "docs-only" | "unknown";

export type CompatibilityChangeKind =
  | "constraint-changed"
  | "documentation-changed"
  | "event-added"
  | "event-removed"
  | "property-added"
  | "property-removed"
  | "required-changed"
  | "schema-changed"
  | "signature-changed"
  | "type-changed"
  | "version-added"
  | "version-removed";

export interface CompatibilityChange {
  readonly code: string;
  readonly eventId?: string;
  readonly kind: CompatibilityChangeKind;
  readonly message: string;
  readonly next?: JsonValue;
  readonly pointer: string;
  readonly previous?: JsonValue;
  readonly status: CompatibilityStatus;
}

export interface CompatibilityResult {
  readonly changes: readonly CompatibilityChange[];
  readonly nextChecksum: Sha256Checksum;
  readonly previousChecksum: Sha256Checksum;
  readonly status: CompatibilityStatus;
  readonly summary: string;
}

export type OriginalContractSource =
  | {
      readonly kind: "document";
      readonly mediaType: SourceMediaType;
      readonly value: JsonObject;
    }
  | {
      readonly kind: "text";
      readonly mediaType: SourceMediaType;
      readonly value: string;
    };

export interface CanonicalContractExport {
  readonly canonical: CanonicalContract;
  readonly checksums: {
    readonly canonical: Sha256Checksum;
    readonly source: Sha256Checksum;
  };
  readonly format: typeof CANONICAL_EXPORT_FORMAT;
  readonly formatVersion: typeof CANONICAL_EXPORT_VERSION;
  readonly original: OriginalContractSource;
}
