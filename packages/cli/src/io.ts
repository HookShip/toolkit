// SPDX-License-Identifier: Apache-2.0

import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { on } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { redactSecrets } from "@webhook-portal/adapter-sdk";
import { parse as parseYaml } from "yaml";

export interface CliStreams {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface BoundedReadOptions {
  readonly maxBytes: number;
  readonly timeoutMilliseconds: number;
}

interface DirectorySyncHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
}

export interface AtomicWriteFileOptions {
  readonly openDirectory?: (directory: string) => Promise<DirectorySyncHandle>;
  readonly platform?: NodeJS.Platform;
}

export class StdinSourceConflictError extends Error {
  readonly sources: readonly string[];

  constructor(sources: readonly string[]) {
    super(
      `Only one input may read stdin; conflicting sources: ${sources.join(", ")}.`,
    );
    this.name = "StdinSourceConflictError";
    this.sources = sources;
  }
}

export function assertSingleStdinConsumer(
  sources: readonly {
    readonly name: string;
    readonly usesStdin: boolean;
  }[],
): void {
  const consumers = sources
    .filter((source) => source.usesStdin)
    .map((source) => source.name);
  if (consumers.length > 1) {
    throw new StdinSourceConflictError(consumers);
  }
}

export async function readBoundedStream(
  stream: Readable,
  options: BoundedReadOptions,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const initiallyFlowing = stream.readableFlowing;
  const controller = new AbortController();
  const iterator = on(stream, "data", {
    close: ["close", "end"],
    signal: controller.signal,
  });
  stream.resume();
  const timeoutError = new Error("Input read deadline exceeded.");
  let timedOut = false;
  let completed = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
    if (initiallyFlowing !== true) {
      stream.pause();
    }
  }, options.timeoutMilliseconds);
  timer.unref();
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        completed = true;
        return Buffer.concat(chunks);
      }
      for (const chunk of next.value) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), "utf8");
        size += bytes.byteLength;
        if (size > options.maxBytes) {
          throw new RangeError(
            `Input exceeded the ${options.maxBytes}-byte limit.`,
          );
        }
        chunks.push(bytes);
      }
    }
  } catch (error) {
    if (timedOut) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (!completed && stream === process.stdin) {
      (
        stream as Readable & {
          unref?: () => void;
        }
      ).unref?.();
    }
    await iterator.return?.();
    if (initiallyFlowing !== true && !stream.readableEnded) {
      stream.pause();
    }
  }
}

export async function readInputBytes(
  inputPath: string,
  streams: CliStreams,
  options: BoundedReadOptions,
): Promise<Buffer> {
  if (inputPath === "-") {
    return readBoundedStream(streams.stdin, options);
  }
  const metadata = await stat(inputPath);
  if (!metadata.isFile()) {
    throw new RangeError("Input path must reference a regular file.");
  }
  if (metadata.size > options.maxBytes) {
    throw new RangeError(`Input exceeded the ${options.maxBytes}-byte limit.`);
  }
  return readFile(inputPath);
}

export async function readInputText(
  inputPath: string,
  streams: CliStreams,
  options: BoundedReadOptions,
): Promise<string> {
  const bytes = await readInputBytes(inputPath, streams, options);
  return bytes.toString("utf8");
}

export function parseJsonOrYaml(source: string, sourceName = "input"): unknown {
  try {
    return source.trimStart().startsWith("{") ||
      source.trimStart().startsWith("[")
      ? (JSON.parse(source) as unknown)
      : parseYaml(source, {
          maxAliasCount: 20,
          merge: false,
          uniqueKeys: true,
        });
  } catch {
    throw new SyntaxError(`${sourceName} is not valid JSON or YAML.`);
  }
}

export async function atomicWriteFile(
  destination: string,
  content: string | Uint8Array,
  mode = 0o644,
  options: AtomicWriteFileOptions = {},
): Promise<void> {
  const directory = path.dirname(destination);
  const base = path.basename(destination);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${base}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await rename(temporary, destination);
    await syncDirectoryAfterRename(directory, options);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const UNSUPPORTED_WINDOWS_DIRECTORY_SYNC_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EPERM",
]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function syncDirectoryAfterRename(
  directory: string,
  options: AtomicWriteFileOptions,
): Promise<void> {
  let handle: DirectorySyncHandle | undefined;
  try {
    handle = await (options.openDirectory ?? ((value) => open(value, "r")))(
      directory,
    );
    await handle.sync();
  } catch (error) {
    if (
      (options.platform ?? process.platform) !== "win32" ||
      !UNSUPPORTED_WINDOWS_DIRECTORY_SYNC_CODES.has(errorCode(error) ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

const SECRET_PATTERNS = [
  /whsec_[A-Za-z0-9+/=]{16,}/gu,
  /\b(?:authorization|api[-_]?key|secret|token|password)\s*[:=]\s*["']?[^,\s"']+/giu,
] as const;

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED]"),
    value,
  );
}

const SAFE_DIAGNOSTIC_KEYS = new Set([
  "accepted",
  "attempts",
  "availableVersions",
  "batchId",
  "canonicalChecksum",
  "changeCount",
  "code",
  "column",
  "compatibility",
  "currentVersion",
  "details",
  "diagnostics",
  "endpointDeleted",
  "error",
  "evidenceState",
  "expectedVersion",
  "format",
  "generationStatus",
  "idempotencyKey",
  "importId",
  "late",
  "line",
  "message",
  "messageId",
  "missingVersions",
  "pendingObjectCount",
  "phase",
  "pointer",
  "releaseId",
  "requestId",
  "severity",
  "sourceChecksum",
  "sourceUri",
  "specificationVersion",
  "state",
  "status",
  "statusPath",
  "supported",
]);

function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (!SAFE_DIAGNOSTIC_KEYS.has(key)) {
          return [key, "[REDACTED]"];
        }
        return [key, redactDiagnosticValue(item)];
      }),
    );
  }
  return value;
}

export function redactDiagnostic(value: unknown): unknown {
  return redactDiagnosticValue(redactSecrets(value));
}

export function safeErrorMessage(error: unknown): string {
  return redactText(
    error instanceof Error ? error.message : "Unexpected command failure.",
  );
}

export function writeLine(stream: Writable, value: string): void {
  stream.write(`${value}\n`);
}
