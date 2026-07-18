// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  canonicalJson,
  canonicalJsonDigest,
  compareUtf16CodeUnits,
  equalDigest,
  parseCanonicalJson,
  sha256Digest,
  type JsonValue,
} from "./canonical.js";
import { BundleError, ExtensionSdkError } from "./errors.js";
import {
  EXTENSION_ASSET_MEDIA_TYPES,
  manifestContentValue,
  normalizeAssetPath,
  normalizeExtensionManifestDraft,
  parseExtensionManifest,
  type ExtensionAssetMediaType,
  type ExtensionManifest,
  type ExtensionManifestDraft,
  type ExtensionResource,
} from "./manifest.js";
import {
  signBundleDigest,
  verifyBundleDigestSignatures,
  type ExtensionSigningKey,
  type SignatureTrustPolicy,
  type SignatureVerificationError,
} from "./signatures.js";
import {
  expectEnum,
  expectInteger,
  expectString,
  inspectArray,
  inspectClosedObject,
} from "./validation.js";

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

function boundedLimits(limits: ExtensionBundleLimits = {}) {
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

function normalizeAssets(
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

function assertResourceAgreement(
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

function assertCurrentDigests(bundle: ExtensionBundle): void {
  const contentDigest = computeExtensionContentDigest(bundle.manifest);
  if (!equalDigest(contentDigest, bundle.manifest.integrity.contentDigest)) {
    throw new BundleError(
      "CONTENT_DIGEST_MISMATCH",
      "Manifest content digest is stale or invalid.",
    );
  }
  const bundleDigest = computeExtensionBundleDigest(bundle);
  if (!equalDigest(bundleDigest, bundle.manifest.integrity.bundleDigest)) {
    throw new BundleError(
      "BUNDLE_DIGEST_MISMATCH",
      "Bundle digest is stale or invalid.",
    );
  }
}

export function signExtensionBundle(
  value: ExtensionBundle,
  signer: ExtensionSigningKey,
): ExtensionBundle {
  const bundle = parseExtensionBundle(value);
  assertCurrentDigests(bundle);
  if (
    bundle.manifest.integrity.signatures.some(
      (signature) => signature.keyId === signer.keyId,
    )
  ) {
    throw new BundleError(
      "DUPLICATE_SIGNATURE",
      `Bundle already contains a signature from key ${signer.keyId}.`,
    );
  }
  const signature = signBundleDigest(
    bundle.manifest.integrity.bundleDigest,
    signer,
  );
  return parseExtensionBundle({
    ...bundle,
    manifest: {
      ...bundle.manifest,
      integrity: {
        ...bundle.manifest.integrity,
        signatures: [...bundle.manifest.integrity.signatures, signature],
      },
    },
  });
}

function issue(
  code: BundleVerificationIssue["code"],
  message: string,
): BundleVerificationIssue {
  return Object.freeze({ code, message });
}

export function verifyExtensionBundle(
  value: unknown,
  options: {
    readonly limits?: ExtensionBundleLimits;
    readonly trustPolicy: SignatureTrustPolicy;
  },
): BundleVerificationResult {
  let bundle: ExtensionBundle;
  try {
    bundle = parseExtensionBundle(value, options.limits);
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "Bundle validation failed.";
    return Object.freeze({
      ok: false,
      issues: Object.freeze([issue("MALFORMED_BUNDLE", message)]),
      signatureErrors: Object.freeze([]),
      validKeyIds: Object.freeze([]),
    });
  }
  const issues: BundleVerificationIssue[] = [];
  const contentDigest = computeExtensionContentDigest(bundle.manifest);
  if (!equalDigest(contentDigest, bundle.manifest.integrity.contentDigest)) {
    issues.push(
      issue(
        "CONTENT_DIGEST_MISMATCH",
        "Manifest content digest does not match canonical content.",
      ),
    );
  }
  const bundleDigest = computeExtensionBundleDigest(bundle);
  if (!equalDigest(bundleDigest, bundle.manifest.integrity.bundleDigest)) {
    issues.push(
      issue(
        "BUNDLE_DIGEST_MISMATCH",
        "Bundle digest does not match canonical bundle content.",
      ),
    );
  }
  const signatures = verifyBundleDigestSignatures(
    bundle.manifest.integrity.bundleDigest,
    bundle.manifest.integrity.signatures,
    options.trustPolicy,
  );
  if (!signatures.ok) {
    issues.push(
      issue(
        "SIGNATURE_VERIFICATION_FAILED",
        "Bundle did not satisfy the signature trust policy.",
      ),
    );
  }
  return Object.freeze({
    ok: issues.length === 0,
    bundle,
    issues: Object.freeze(issues),
    signatureErrors: signatures.errors,
    validKeyIds: signatures.validKeyIds,
  });
}

async function decodeTextFile(
  absolutePath: string,
  relativePath: string,
  maximumBytes: number,
): Promise<string> {
  const handle = await open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new BundleError(
        "UNSUPPORTED_FILE_TYPE",
        `${relativePath} is not a regular file.`,
        relativePath,
      );
    }
    if ((metadata.mode & 0o111) !== 0) {
      throw new BundleError(
        "EXECUTABLE_ASSET",
        `${relativePath} has executable permission bits.`,
        relativePath,
      );
    }
    if (metadata.size > maximumBytes) {
      throw new BundleError(
        "ASSET_SIZE_LIMIT",
        `${relativePath} exceeds the per-asset byte limit.`,
        relativePath,
      );
    }
    const bytes = await handle.readFile();
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new Error("Non-canonical UTF-8");
    }
    return content;
  } catch (cause) {
    if (cause instanceof ExtensionSdkError) {
      throw cause;
    }
    throw new BundleError(
      "BINARY_ASSET",
      `${relativePath} is not canonical UTF-8 text.`,
      relativePath,
    );
  } finally {
    await handle.close();
  }
}

export async function packExtensionDirectory(input: {
  readonly directory: string;
  readonly limits?: ExtensionBundleLimits;
  readonly manifest: ExtensionManifestDraft;
}): Promise<ExtensionBundle> {
  const limits = boundedLimits(input.limits);
  const draft = normalizeExtensionManifestDraft(input.manifest);
  const root = path.resolve(input.directory);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new BundleError(
      "INVALID_BUNDLE_DIRECTORY",
      "Bundle root must be a real directory, not a symlink.",
    );
  }
  const declared = new Map(
    draft.resources.map((resource) => [resource.path, resource]),
  );
  const found = new Map<string, BundleAssetInput>();

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 32) {
      throw new BundleError(
        "DIRECTORY_DEPTH_LIMIT",
        "Bundle directory exceeds the hard nesting limit.",
      );
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeAssetPath(
        path.relative(root, absolute).split(path.sep).join("/"),
        "bundle file path",
      );
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new BundleError(
          "SYMLINK_ASSET",
          `${relative} is a symlink.`,
          relative,
        );
      }
      if (metadata.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      if (!metadata.isFile()) {
        throw new BundleError(
          "UNSUPPORTED_FILE_TYPE",
          `${relative} is not a regular file.`,
          relative,
        );
      }
      if ((metadata.mode & 0o111) !== 0) {
        throw new BundleError(
          "EXECUTABLE_ASSET",
          `${relative} has executable permission bits.`,
          relative,
        );
      }
      const declaration = declared.get(relative);
      if (declaration === undefined) {
        throw new BundleError(
          "UNLISTED_ASSET",
          `${relative} is not listed in the manifest.`,
          relative,
        );
      }
      if (found.size >= limits.maximumAssets) {
        throw new BundleError(
          "ASSET_COUNT_LIMIT",
          "Bundle contains too many assets.",
        );
      }
      const content = await decodeTextFile(
        absolute,
        relative,
        limits.maximumAssetBytes,
      );
      found.set(relative, {
        path: relative,
        mediaType: declaration.mediaType,
        content,
      });
    }
  };

  try {
    await visit(root, 0);
  } catch (cause) {
    if (cause instanceof ExtensionSdkError) {
      throw cause;
    }
    throw new BundleError(
      "PACK_IO_ERROR",
      "Bundle directory could not be packed safely.",
    );
  }
  for (const resource of draft.resources) {
    if (!found.has(resource.path)) {
      throw new BundleError(
        "MISSING_ASSET",
        `Manifest resource ${resource.path} is missing from the directory.`,
        resource.path,
      );
    }
  }
  return createExtensionBundle({
    manifest: draft,
    assets: [...found.values()],
    limits,
  });
}

export function canonicalJsonAsset(value: JsonValue): string {
  return canonicalJson(value, {
    maximumDepth: HARD_BUNDLE_LIMITS.maximumJsonDepth,
    maximumOutputBytes: HARD_BUNDLE_LIMITS.maximumAssetBytes,
  });
}
