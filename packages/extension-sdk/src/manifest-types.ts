// SPDX-License-Identifier: Apache-2.0

import type { PermissionSet } from "./permissions.js";
import type { BundleSignature } from "./signatures.js";

export const EXTENSION_MANIFEST_VERSION = "1.0" as const;
export const EXTENSION_KINDS = [
  "connector",
  "policy",
  "template",
  "transform",
] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const EXTENSION_CAPABILITIES = [
  "connector.configuration",
  "connector.templates",
  "policy.declarative",
  "template.assets",
  "transform.declarative",
] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

export const EXTENSION_ASSET_MEDIA_TYPES = [
  "application/json",
  "application/schema+json",
  "text/markdown",
  "text/plain",
  "text/x-webhook-template",
] as const;
export type ExtensionAssetMediaType =
  (typeof EXTENSION_ASSET_MEDIA_TYPES)[number];

export interface ExtensionPublisher {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
}

export interface ExtensionIdentity {
  readonly id: string;
  readonly name: string;
  readonly publisher: ExtensionPublisher;
  readonly version: string;
}

export interface ExtensionDependency {
  readonly id: string;
  readonly optional: boolean;
  readonly range: string;
}

export interface ExtensionConflict {
  readonly id: string;
  readonly range: string;
  readonly reason: string;
}

export interface ExtensionCompatibility {
  readonly conflicts: readonly ExtensionConflict[];
  readonly dependencies: readonly ExtensionDependency[];
  readonly platform: string;
  readonly sdk: string;
}

export interface ResourceDeclaration {
  readonly mediaType: ExtensionAssetMediaType;
  readonly path: string;
}

export interface ExtensionResource extends ResourceDeclaration {
  readonly digest: string;
  readonly size: number;
}

export interface ConnectorEntry {
  readonly configurationSchema: string;
  readonly templates: readonly string[];
  readonly type: "connector";
}

export interface TransformEntry {
  readonly program: string;
  readonly type: "transform";
}

export interface PolicyEntry {
  readonly program: string;
  readonly type: "policy";
}

export interface TemplateDeclaration {
  readonly mediaType:
    "text/markdown" | "text/plain" | "text/x-webhook-template";
  readonly name: string;
  readonly path: string;
}

export interface TemplateEntry {
  readonly templates: readonly TemplateDeclaration[];
  readonly type: "template";
}

export type ExtensionEntry =
  ConnectorEntry | PolicyEntry | TemplateEntry | TransformEntry;

export interface SbomDependency {
  readonly direct: boolean;
  readonly digest?: string;
  readonly license?: string;
  readonly name: string;
  readonly purl?: string;
  readonly relationship: "build" | "optional" | "runtime";
  readonly version: string;
}

export interface ExtensionProvenance {
  readonly build: {
    readonly buildType: string;
    readonly builder: string;
    readonly reproducible: boolean;
    readonly timestamp: string;
  };
  readonly sbom: {
    readonly dependencies: readonly SbomDependency[];
    readonly format: "webhook-portal-sbom-v1";
  };
  readonly source: {
    readonly repository: string;
    readonly revision: string;
  };
}

export interface ExtensionIntegrity {
  readonly bundleDigest: string;
  readonly contentDigest: string;
  readonly signatures: readonly BundleSignature[];
}

interface ExtensionManifestBase {
  readonly capabilities: readonly ExtensionCapability[];
  readonly compatibility: ExtensionCompatibility;
  readonly entry: ExtensionEntry;
  readonly identity: ExtensionIdentity;
  readonly kind: ExtensionKind;
  readonly manifestVersion: typeof EXTENSION_MANIFEST_VERSION;
  readonly permissions: PermissionSet;
  readonly provenance: ExtensionProvenance;
}

export interface ExtensionManifestDraft extends ExtensionManifestBase {
  readonly resources: readonly ResourceDeclaration[];
}

export interface ExtensionManifest extends ExtensionManifestBase {
  readonly integrity: ExtensionIntegrity;
  readonly resources: readonly ExtensionResource[];
}
