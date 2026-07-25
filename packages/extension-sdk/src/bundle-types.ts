// SPDX-License-Identifier: Apache-2.0

import type {
  ExtensionManifest,
  ExtensionAssetMediaType,
} from "./manifest-types.js";
import type { SignatureVerificationError } from "./signatures.js";

export const EXTENSION_BUNDLE_FORMAT =
  "webhook-portal-extension-bundle-v1" as const;
export const EMPTY_SHA256_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const;

export interface ExtensionBundleLimits {
  readonly maximumAssetBytes?: number;
  readonly maximumAssets?: number;
  readonly maximumBundleBytes?: number;
  readonly maximumJsonDepth?: number;
  readonly maximumTotalAssetBytes?: number;
}

export const HARD_BUNDLE_LIMITS = Object.freeze({
  maximumAssetBytes: 1024 * 1024,
  maximumAssets: 256,
  maximumBundleBytes: 10 * 1024 * 1024,
  maximumJsonDepth: 64,
  maximumTotalAssetBytes: 8 * 1024 * 1024,
});

export interface BundleAsset {
  readonly content: string;
  readonly digest: string;
  readonly encoding: "utf8";
  readonly mediaType: ExtensionAssetMediaType;
  readonly path: string;
  readonly size: number;
}

export interface ExtensionBundle {
  readonly assets: readonly BundleAsset[];
  readonly format: typeof EXTENSION_BUNDLE_FORMAT;
  readonly manifest: ExtensionManifest;
}

export interface BundleAssetInput {
  readonly content: string;
  readonly mediaType: ExtensionAssetMediaType;
  readonly path: string;
}

export interface BundleVerificationIssue {
  readonly code:
    | "BUNDLE_DIGEST_MISMATCH"
    | "CONTENT_DIGEST_MISMATCH"
    | "MALFORMED_BUNDLE"
    | "SIGNATURE_VERIFICATION_FAILED";
  readonly message: string;
}

export interface BundleVerificationResult {
  readonly bundle?: ExtensionBundle;
  readonly issues: readonly BundleVerificationIssue[];
  readonly ok: boolean;
  readonly signatureErrors: readonly SignatureVerificationError[];
  readonly validKeyIds: readonly string[];
}
