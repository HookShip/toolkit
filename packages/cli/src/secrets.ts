// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from "node:fs/promises";
import type { Readable } from "node:stream";

import { readBoundedStream } from "./io.js";

export interface SecretSourceOptions {
  readonly secretEnv?: string;
  readonly secretFile?: string;
  readonly secretStdin?: boolean;
}

export interface ReadSecretOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin: Readable;
  readonly defaultEnvironmentName: string;
}

function normalizeSecret(value: string): string {
  const normalized = value.replace(/\r?\n$/u, "");
  if (normalized.length === 0 || Buffer.byteLength(normalized) > 4096) {
    throw new RangeError("Secret input is empty or exceeds its size limit.");
  }
  return normalized;
}

export async function readSecret(
  source: SecretSourceOptions,
  options: ReadSecretOptions,
): Promise<string> {
  const explicitSources = [
    source.secretEnv !== undefined,
    source.secretFile !== undefined,
    source.secretStdin === true,
  ].filter(Boolean).length;
  if (explicitSources > 1) {
    throw new RangeError(
      "Choose exactly one secret source: environment, file, or stdin.",
    );
  }
  if (source.secretStdin === true) {
    const bytes = await readBoundedStream(options.stdin, {
      maxBytes: 4096,
      timeoutMilliseconds: 5000,
    });
    return normalizeSecret(bytes.toString("utf8"));
  }
  if (source.secretFile !== undefined) {
    const metadata = await stat(source.secretFile);
    if (!metadata.isFile()) {
      throw new RangeError("Secret path must reference a regular file.");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new RangeError(
        "Secret file permissions must not grant group or other access.",
      );
    }
    if (metadata.size > 4096) {
      throw new RangeError("Secret file exceeds its size limit.");
    }
    return normalizeSecret(await readFile(source.secretFile, "utf8"));
  }
  const environmentName = source.secretEnv ?? options.defaultEnvironmentName;
  const value = options.environment[environmentName];
  if (value === undefined) {
    throw new RangeError(
      `Secret environment variable ${environmentName} is not set.`,
    );
  }
  return normalizeSecret(value);
}
