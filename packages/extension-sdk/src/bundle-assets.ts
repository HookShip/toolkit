// SPDX-License-Identifier: Apache-2.0

import {
  compareUtf16CodeUnits,
  equalDigest,
  parseCanonicalJson,
  sha256Digest,
  type JsonValue,
} from "./canonical.js";
import { BundleError } from "./errors.js";
import {
  EXTENSION_ASSET_MEDIA_TYPES,
  type ExtensionAssetMediaType,
  type ExtensionResource,
} from "./manifest-types.js";
import { normalizeAssetPath } from "./manifest-utils.js";
import {
  expectEnum,
  expectInteger,
  expectString,
  inspectArray,
  inspectClosedObject,
} from "./validation.js";
import {
  HARD_BUNDLE_LIMITS,
  type BundleAsset,
  type ExtensionBundleLimits,
} from "./bundle-types.js";

export function boundedLimits(limits: ExtensionBundleLimits = {}) {
  const limit = (
    value: number | undefined,
    hard: number,
    path: string,
  ): number => {
    if (value === undefined) {
      return hard;
    }
    return expectInteger(value, path, 1, hard);
  };
  return Object.freeze({
    maximumAssetBytes: limit(
      limits.maximumAssetBytes,
      HARD_BUNDLE_LIMITS.maximumAssetBytes,
      "limits.maximumAssetBytes",
    ),
    maximumAssets: limit(
      limits.maximumAssets,
      HARD_BUNDLE_LIMITS.maximumAssets,
      "limits.maximumAssets",
    ),
    maximumBundleBytes: limit(
      limits.maximumBundleBytes,
      HARD_BUNDLE_LIMITS.maximumBundleBytes,
      "limits.maximumBundleBytes",
    ),
    maximumJsonDepth: limit(
      limits.maximumJsonDepth,
      HARD_BUNDLE_LIMITS.maximumJsonDepth,
      "limits.maximumJsonDepth",
    ),
    maximumTotalAssetBytes: limit(
      limits.maximumTotalAssetBytes,
      HARD_BUNDLE_LIMITS.maximumTotalAssetBytes,
      "limits.maximumTotalAssetBytes",
    ),
  });
}

function assertTextAsset(content: string, path: string): void {
  if (content.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new BundleError(
      "SECRET_MATERIAL",
      `${path} appears to contain private key material.`,
      path,
    );
  }
  for (const character of content) {
    const code = character.charCodeAt(0);
    if (
      code === 0 ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    ) {
      throw new BundleError(
        "BINARY_ASSET",
        `${path} contains binary or unsupported control data.`,
        path,
      );
    }
  }
}

function assertNoSerializedSecretMaterial(
  value: JsonValue,
  path: string,
): void {
  const prohibited = new Set([
    "accessToken",
    "clientSecretValue",
    "credentialValue",
    "passwordValue",
    "privateKey",
    "refreshToken",
    "secretValue",
  ]);
  const visit = (candidate: JsonValue, candidatePath: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) =>
        visit(item, `${candidatePath}[${index}]`),
      );
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (prohibited.has(key)) {
        throw new BundleError(
          "SECRET_MATERIAL",
          `${candidatePath}.${key} must use a secret reference instead of material.`,
          `${candidatePath}.${key}`,
        );
      }
      visit(child, `${candidatePath}.${key}`);
    }
  };
  visit(value, path);
}

function validateAssetContent(
  content: string,
  mediaType: ExtensionAssetMediaType,
  assetPath: string,
  maximumJsonDepth: number,
): void {
  assertTextAsset(content, assetPath);
  if (
    mediaType === "application/json" ||
    mediaType === "application/schema+json"
  ) {
    const parsed = parseCanonicalJson(content, {
      maximumDepth: maximumJsonDepth,
      maximumOutputBytes: HARD_BUNDLE_LIMITS.maximumAssetBytes,
    });
    if (mediaType === "application/json") {
      assertNoSerializedSecretMaterial(parsed, assetPath);
    }
  }
}

function normalizeAsset(
  value: unknown,
  index: number,
  limits: ReturnType<typeof boundedLimits>,
  complete: boolean,
): BundleAsset {
  const assetPath = `bundle.assets[${index}]`;
  const object = inspectClosedObject(
    value,
    assetPath,
    complete
      ? ["path", "mediaType", "encoding", "content", "size", "digest"]
      : ["path", "mediaType", "content"],
  );
  const normalizedPath = normalizeAssetPath(object.path, `${assetPath}.path`);
  const mediaType = expectEnum(
    object.mediaType,
    `${assetPath}.mediaType`,
    EXTENSION_ASSET_MEDIA_TYPES,
  );
  const content = expectString(object.content, `${assetPath}.content`, {
    allowEmpty: true,
    maximumLength: limits.maximumAssetBytes,
  });
  const size = Buffer.byteLength(content, "utf8");
  if (size > limits.maximumAssetBytes) {
    throw new BundleError(
      "ASSET_SIZE_LIMIT",
      `${normalizedPath} exceeds the per-asset byte limit.`,
      normalizedPath,
    );
  }
  validateAssetContent(
    content,
    mediaType,
    normalizedPath,
    limits.maximumJsonDepth,
  );
  const digest = sha256Digest(Buffer.from(content, "utf8"));
  if (complete) {
    expectEnum(object.encoding, `${assetPath}.encoding`, ["utf8"] as const);
    const declaredSize = expectInteger(
      object.size,
      `${assetPath}.size`,
      0,
      limits.maximumAssetBytes,
    );
    const declaredDigest = expectString(object.digest, `${assetPath}.digest`, {
      maximumLength: 71,
    });
    if (declaredSize !== size) {
      throw new BundleError(
        "ASSET_SIZE_MISMATCH",
        `${normalizedPath} size metadata does not match its UTF-8 bytes.`,
        normalizedPath,
      );
    }
    if (!equalDigest(declaredDigest, digest)) {
      throw new BundleError(
        "ASSET_DIGEST_MISMATCH",
        `${normalizedPath} digest does not match its content.`,
        normalizedPath,
      );
    }
  }
  return Object.freeze({
    path: normalizedPath,
    mediaType,
    encoding: "utf8",
    content,
    size,
    digest,
  });
}

export function normalizeAssets(
  value: unknown,
  limits: ReturnType<typeof boundedLimits>,
  complete: boolean,
): readonly BundleAsset[] {
  const candidates = inspectArray(value, "bundle.assets", limits.maximumAssets);
  const assets = candidates.map((candidate, index) =>
    normalizeAsset(candidate, index, limits, complete),
  );
  let total = 0;
  const aliases = new Set<string>();
  for (const asset of assets) {
    total += asset.size;
    if (total > limits.maximumTotalAssetBytes) {
      throw new BundleError(
        "TOTAL_ASSET_SIZE_LIMIT",
        "Bundle exceeds the total asset byte limit.",
        "bundle.assets",
      );
    }
    const alias = asset.path.toLowerCase();
    if (aliases.has(alias)) {
      throw new BundleError(
        "DUPLICATE_ASSET_PATH",
        `Bundle contains duplicate or case-colliding path ${asset.path}.`,
        asset.path,
      );
    }
    aliases.add(alias);
  }
  return Object.freeze(
    [...assets].sort((left, right) =>
      compareUtf16CodeUnits(left.path, right.path),
    ),
  );
}

export function assertResourceAgreement(
  resources: readonly ExtensionResource[],
  assets: readonly BundleAsset[],
): void {
  if (resources.length !== assets.length) {
    throw new BundleError(
      "RESOURCE_SET_MISMATCH",
      "Manifest resource count does not match bundle assets.",
      "manifest.resources",
    );
  }
  for (let index = 0; index < resources.length; index += 1) {
    const resource = resources[index];
    const asset = assets[index];
    if (
      resource === undefined ||
      asset === undefined ||
      resource.path !== asset.path ||
      resource.mediaType !== asset.mediaType ||
      resource.size !== asset.size ||
      !equalDigest(resource.digest, asset.digest)
    ) {
      throw new BundleError(
        "RESOURCE_SET_MISMATCH",
        "Manifest resources do not exactly describe bundle assets.",
        `manifest.resources[${index}]`,
      );
    }
  }
}
