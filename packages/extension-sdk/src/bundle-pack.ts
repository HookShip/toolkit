// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { compareUtf16CodeUnits } from "./canonical.js";
import { BundleError, ExtensionSdkError } from "./errors.js";
import { normalizeExtensionManifestDraft } from "./manifest-parser.js";
import { normalizeAssetPath } from "./manifest-utils.js";
import type { ExtensionManifestDraft } from "./manifest-types.js";
import { boundedLimits } from "./bundle-assets.js";
import { createExtensionBundle } from "./bundle-core.js";
import type {
  BundleAssetInput,
  ExtensionBundle,
  ExtensionBundleLimits,
} from "./bundle-types.js";

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
