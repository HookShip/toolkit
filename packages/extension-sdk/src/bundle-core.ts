// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  canonicalJsonDigest,
  type JsonValue,
} from "./canonical.js";
import { BundleError } from "./errors.js";
import {
  manifestContentValue,
  normalizeExtensionManifestDraft,
  parseExtensionManifest,
} from "./manifest-parser.js";
import type {
  ExtensionManifest,
  ExtensionManifestDraft,
  ExtensionResource,
} from "./manifest-types.js";
import { expectEnum, inspectClosedObject } from "./validation.js";
import {
  assertResourceAgreement,
  boundedLimits,
  normalizeAssets,
} from "./bundle-assets.js";
import {
  EMPTY_SHA256_DIGEST,
  EXTENSION_BUNDLE_FORMAT,
  HARD_BUNDLE_LIMITS,
  type BundleAssetInput,
  type ExtensionBundle,
  type ExtensionBundleLimits,
} from "./bundle-types.js";

function bundleDigestValue(bundle: ExtensionBundle): JsonValue {
  return {
    format: bundle.format,
    manifest: {
      ...bundle.manifest,
      integrity: {
        contentDigest: bundle.manifest.integrity.contentDigest,
        bundleDigest: EMPTY_SHA256_DIGEST,
        signatures: [],
      },
    },
    assets: bundle.assets,
  } as unknown as JsonValue;
}

export function computeExtensionContentDigest(
  manifest: ExtensionManifest,
): string {
  return canonicalJsonDigest(manifestContentValue(manifest), {
    maximumOutputBytes: HARD_BUNDLE_LIMITS.maximumBundleBytes,
  });
}

export function computeExtensionBundleDigest(bundle: ExtensionBundle): string {
  return canonicalJsonDigest(bundleDigestValue(bundle), {
    maximumOutputBytes: HARD_BUNDLE_LIMITS.maximumBundleBytes,
  });
}

export function createExtensionBundle(input: {
  readonly assets: readonly BundleAssetInput[];
  readonly limits?: ExtensionBundleLimits;
  readonly manifest: ExtensionManifestDraft;
}): ExtensionBundle {
  const limits = boundedLimits(input.limits);
  const draft = normalizeExtensionManifestDraft(input.manifest);
  const assets = normalizeAssets(input.assets, limits, false);
  const declarations = draft.resources;
  if (declarations.length !== assets.length) {
    throw new BundleError(
      "RESOURCE_SET_MISMATCH",
      "Manifest declarations must list every asset exactly once.",
    );
  }
  const resources: ExtensionResource[] = declarations.map(
    (declaration, index) => {
      const asset = assets[index];
      if (
        asset === undefined ||
        declaration.path !== asset.path ||
        declaration.mediaType !== asset.mediaType
      ) {
        throw new BundleError(
          "RESOURCE_SET_MISMATCH",
          "Manifest resource declarations do not match sorted bundle assets.",
          `manifest.resources[${index}]`,
        );
      }
      return Object.freeze({
        ...declaration,
        digest: asset.digest,
        size: asset.size,
      });
    },
  );
  const provisional = {
    ...draft,
    resources: Object.freeze(resources),
    integrity: Object.freeze({
      contentDigest: EMPTY_SHA256_DIGEST,
      bundleDigest: EMPTY_SHA256_DIGEST,
      signatures: Object.freeze([]),
    }),
  } as ExtensionManifest;
  const contentDigest = computeExtensionContentDigest(provisional);
  const withContent = {
    ...provisional,
    integrity: Object.freeze({
      ...provisional.integrity,
      contentDigest,
    }),
  };
  const provisionalBundle = Object.freeze({
    format: EXTENSION_BUNDLE_FORMAT,
    manifest: withContent,
    assets,
  });
  const bundleDigest = computeExtensionBundleDigest(provisionalBundle);
  const bundle = Object.freeze({
    ...provisionalBundle,
    manifest: Object.freeze({
      ...withContent,
      integrity: Object.freeze({
        ...withContent.integrity,
        bundleDigest,
      }),
    }),
  });
  const canonicalBytes = Buffer.byteLength(
    canonicalJson(bundle as unknown as JsonValue, {
      maximumOutputBytes: limits.maximumBundleBytes,
    }),
    "utf8",
  );
  if (canonicalBytes > limits.maximumBundleBytes) {
    throw new BundleError(
      "BUNDLE_SIZE_LIMIT",
      "Canonical bundle exceeds the hard bundle byte limit.",
    );
  }
  return parseExtensionBundle(bundle, limits);
}

export function parseExtensionBundle(
  value: unknown,
  limitsInput: ExtensionBundleLimits = {},
): ExtensionBundle {
  const limits = boundedLimits(limitsInput);
  const object = inspectClosedObject(value, "bundle", [
    "format",
    "manifest",
    "assets",
  ]);
  const format = expectEnum(object.format, "bundle.format", [
    EXTENSION_BUNDLE_FORMAT,
  ] as const);
  const manifest = parseExtensionManifest(object.manifest);
  const assets = normalizeAssets(object.assets, limits, true);
  assertResourceAgreement(manifest.resources, assets);
  const bundle = Object.freeze({ format, manifest, assets });
  const bytes = Buffer.byteLength(
    canonicalJson(bundle as unknown as JsonValue, {
      maximumDepth: limits.maximumJsonDepth,
      maximumOutputBytes: limits.maximumBundleBytes,
    }),
    "utf8",
  );
  if (bytes > limits.maximumBundleBytes) {
    throw new BundleError(
      "BUNDLE_SIZE_LIMIT",
      "Canonical bundle exceeds the bundle byte limit.",
    );
  }
  return bundle;
}

export function parseExtensionBundleJson(
  text: string,
  limitsInput: ExtensionBundleLimits = {},
): ExtensionBundle {
  const limits = boundedLimits(limitsInput);
  if (Buffer.byteLength(text, "utf8") > limits.maximumBundleBytes) {
    throw new BundleError(
      "BUNDLE_SIZE_LIMIT",
      "Bundle JSON exceeds the bundle byte limit.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BundleError("MALFORMED_BUNDLE", "Bundle JSON is malformed.");
  }
  const bundle = parseExtensionBundle(value, limits);
  if (serializeExtensionBundle(bundle, limits) !== text) {
    throw new BundleError(
      "NON_CANONICAL_BUNDLE",
      "Bundle JSON is not in canonical form.",
    );
  }
  return bundle;
}

export function serializeExtensionBundle(
  bundle: ExtensionBundle,
  limits: ExtensionBundleLimits = {},
): string {
  const parsed = parseExtensionBundle(bundle, limits);
  return canonicalJson(parsed as unknown as JsonValue, {
    maximumOutputBytes: boundedLimits(limits).maximumBundleBytes,
  });
}

export function canonicalJsonAsset(value: JsonValue): string {
  return canonicalJson(value, {
    maximumDepth: HARD_BUNDLE_LIMITS.maximumJsonDepth,
    maximumOutputBytes: HARD_BUNDLE_LIMITS.maximumAssetBytes,
  });
}
