// SPDX-License-Identifier: Apache-2.0

import { assertWellFormedUnicode } from "./canonical.js";
import { ExtensionValidationError } from "./errors.js";
import { expectString } from "./validation.js";

const EXECUTABLE_SUFFIXES = Object.freeze([
  ".bat",
  ".cjs",
  ".cmd",
  ".com",
  ".dll",
  ".dylib",
  ".exe",
  ".jar",
  ".js",
  ".jsx",
  ".mjs",
  ".node",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".so",
  ".ts",
  ".tsx",
  ".wasm",
]);

export function assertSafeText(value: string, path: string): string {
  assertWellFormedUnicode(value, path);
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) {
      throw new ExtensionValidationError(
        "UNSAFE_TEXT",
        `${path} contains a control character.`,
        path,
      );
    }
  }
  return value;
}

export function parseHttpsUrl(value: unknown, path: string): string {
  const candidate = expectString(value, path, { maximumLength: 2_048 });
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ExtensionValidationError(
      "INVALID_URL",
      `${path} must be an absolute URL.`,
      path,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ExtensionValidationError(
      "UNSAFE_URL",
      `${path} must be HTTPS without credentials or fragments.`,
      path,
    );
  }
  return url.toString();
}

export function normalizeAssetPath(
  value: unknown,
  path = "resource.path",
): string {
  const candidate = expectString(value, path, { maximumLength: 1_024 });
  assertWellFormedUnicode(candidate, path);
  if (
    candidate !== candidate.normalize("NFC") ||
    candidate.startsWith("/") ||
    candidate.endsWith("/") ||
    candidate.includes("\\") ||
    candidate.includes("\u0000") ||
    candidate.includes(":")
  ) {
    throw new ExtensionValidationError(
      "INVALID_ASSET_PATH",
      `${path} must be a relative NFC-normalized POSIX path.`,
      path,
    );
  }
  const segments = candidate.split("/");
  if (
    segments.length > 32 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255,
    )
  ) {
    throw new ExtensionValidationError(
      "PATH_TRAVERSAL",
      `${path} contains an unsafe path segment.`,
      path,
    );
  }
  for (const character of candidate) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) {
      throw new ExtensionValidationError(
        "INVALID_ASSET_PATH",
        `${path} contains a control character.`,
        path,
      );
    }
  }
  const lower = candidate.toLowerCase();
  if (EXECUTABLE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    throw new ExtensionValidationError(
      "EXECUTABLE_ASSET",
      `${path} uses an executable file suffix.`,
      path,
    );
  }
  return candidate;
}
