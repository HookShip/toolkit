// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  assertWellFormedUnicode,
  compareUtf16CodeUnits,
  isSecretValue,
  isSensitiveFieldName,
  revealSecret,
} from "@webhook-portal/adapter-sdk";

export interface WireLimits {
  readonly maxBodyBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export class WireEncodingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WireEncodingError";
    this.code = code;
  }
}

const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

interface NormalizeOptions {
  readonly allowSecrets: boolean;
  readonly fingerprintSecrets: boolean;
  readonly metadata: boolean;
  readonly limits: WireLimits;
}

function normalizeData(value: unknown, options: NormalizeOptions): unknown {
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > options.limits.maxNodes || depth > options.limits.maxDepth) {
      throw new WireEncodingError(
        "wire.structure_limit",
        "The command data exceeds its structural limit.",
      );
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string"
    ) {
      if (typeof candidate === "string") {
        assertWellFormedUnicode(candidate);
      }
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new WireEncodingError(
          "wire.invalid_number",
          "Command data contains a non-finite number.",
        );
      }
      return candidate;
    }
    if (typeof candidate === "undefined") {
      return undefined;
    }
    if (isSecretValue(candidate)) {
      if (!options.allowSecrets) {
        throw new WireEncodingError(
          "wire.secret_forbidden",
          "Secret values are not allowed in this command body.",
        );
      }
      const secret = revealSecret(candidate);
      assertWellFormedUnicode(secret, "Wire secret value");
      return options.fingerprintSecrets
        ? {
            $secretSha256: createHash("sha256")
              .update(secret, "utf8")
              .digest("hex"),
          }
        : secret;
    }
    if (typeof candidate !== "object") {
      throw new WireEncodingError(
        "wire.invalid_type",
        "Command data contains a non-JSON value.",
      );
    }
    if (seen.has(candidate)) {
      throw new WireEncodingError(
        "wire.cycle",
        "Command data must not contain cycles.",
      );
    }
    seen.add(candidate);

    let normalized: unknown;
    if (Array.isArray(candidate)) {
      normalized = candidate.map((entry) => visit(entry, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new WireEncodingError(
          "wire.exotic_object",
          "Command data must contain only plain objects.",
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const entries: [string, unknown][] = [];
      for (const [key, descriptor] of Object.entries(descriptors)) {
        assertWellFormedUnicode(key, "Wire object key");
        if (
          descriptor.enumerable !== true ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          throw new WireEncodingError(
            "wire.accessor_forbidden",
            "Command data must not contain accessors.",
          );
        }
        if (unsafeObjectKeys.has(key)) {
          throw new WireEncodingError(
            "wire.unsafe_key",
            "Command data contains an unsafe object key.",
          );
        }
        if (options.metadata && isSensitiveFieldName(key)) {
          throw new WireEncodingError(
            "wire.sensitive_metadata",
            "Sensitive fields are forbidden in metadata.",
          );
        }
        const item = visit(descriptor.value, depth + 1);
        if (item !== undefined) {
          entries.push([key, item]);
        }
      }
      normalized = Object.fromEntries(
        entries.sort(([left], [right]) => compareUtf16CodeUnits(left, right)),
      );
    }

    seen.delete(candidate);
    return normalized;
  };

  return visit(value, 0);
}

function encodeNormalized(value: unknown, maximumBytes: number): Uint8Array {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.byteLength > maximumBytes) {
    throw new WireEncodingError(
      "wire.body_too_large",
      "The encoded HTTP body exceeds its configured limit.",
    );
  }
  return encoded;
}

export function encodeWireJson(
  value: unknown,
  options: {
    readonly allowSecrets?: boolean;
    readonly metadata?: boolean;
    readonly limits: WireLimits;
  },
): Uint8Array {
  return encodeNormalized(
    normalizeData(value, {
      allowSecrets: options.allowSecrets ?? false,
      fingerprintSecrets: false,
      metadata: options.metadata ?? false,
      limits: options.limits,
    }),
    options.limits.maxBodyBytes,
  );
}

export function fingerprintWireValue(
  value: unknown,
  limits: WireLimits,
): string {
  const normalized = normalizeData(value, {
    allowSecrets: true,
    fingerprintSecrets: true,
    metadata: false,
    limits,
  });
  return createHash("sha256")
    .update(encodeNormalized(normalized, limits.maxBodyBytes))
    .digest("hex");
}

export function parseBoundedJson(
  body: Uint8Array | string | undefined,
  limits: WireLimits,
): unknown {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    assertWellFormedUnicode(body, "HTTP response body");
  }
  const bytes =
    typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  if (bytes.byteLength > limits.maxBodyBytes) {
    throw new WireEncodingError(
      "wire.response_too_large",
      "The HTTP response body exceeds its configured limit.",
    );
  }
  if (bytes.byteLength === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new WireEncodingError(
      "wire.invalid_json",
      "The HTTP response is not valid JSON.",
    );
  }
  return normalizeData(parsed, {
    allowSecrets: false,
    fingerprintSecrets: false,
    metadata: false,
    limits,
  });
}
