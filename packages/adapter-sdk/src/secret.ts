// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";

import { assertWellFormedUnicode, isWellFormedUnicode } from "./canonical.js";

export const REDACTED_SECRET = "[REDACTED]" as const;

const sensitiveKeyPattern =
  /(api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)/iu;

export interface SecretValueOptions {
  readonly id?: string;
  readonly purpose?: string;
}

export class SecretValue {
  readonly id: string | undefined;
  readonly purpose: string | undefined;
  readonly #value: string;

  constructor(value: string, options: SecretValueOptions = {}) {
    assertWellFormedUnicode(value, "Secret value");
    if (
      value.length === 0 ||
      value.length > 65_536 ||
      value.includes("\u0000")
    ) {
      throw new RangeError("Secret values must be non-empty and bounded.");
    }
    for (const [name, item] of [
      ["secret.id", options.id],
      ["secret.purpose", options.purpose],
    ] as const) {
      if (
        item !== undefined &&
        (item.length === 0 ||
          item.length > 512 ||
          !isWellFormedUnicode(item) ||
          /[\u0000-\u001f\u007f]/u.test(item))
      ) {
        throw new RangeError(`${name} must be a safe well-formed string.`);
      }
    }
    this.#value = value;
    this.id = options.id;
    this.purpose = options.purpose;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `[SecretValue ${REDACTED_SECRET}]`;
  }

  toJSON(): Readonly<{
    id?: string;
    purpose?: string;
    type: "SecretValue";
    value: typeof REDACTED_SECRET;
  }> {
    return {
      type: "SecretValue",
      value: REDACTED_SECRET,
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.purpose === undefined ? {} : { purpose: this.purpose }),
    };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export function secretValue(
  value: string,
  options: SecretValueOptions = {},
): SecretValue {
  return new SecretValue(value, options);
}

export function isSecretValue(value: unknown): value is SecretValue {
  return value instanceof SecretValue;
}

export function revealSecret(value: SecretValue): string {
  return value.reveal();
}

export function hasSameSecretMaterial(
  left: SecretValue,
  right: SecretValue,
): boolean {
  const leftDigest = createHash("sha256")
    .update(left.reveal(), "utf8")
    .digest();
  const rightDigest = createHash("sha256")
    .update(right.reveal(), "utf8")
    .digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function isSensitiveFieldName(name: string): boolean {
  return sensitiveKeyPattern.test(name);
}

type SecretCommandOperation = "secret.create" | "secret.rotate_with_overlap";

interface SecretCommandScope {
  readonly inputPath: readonly string[];
  readonly operation: SecretCommandOperation;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function secretCommandOperation(
  value: unknown,
): SecretCommandOperation | undefined {
  return value === "secret.create" || value === "secret.rotate_with_overlap"
    ? value
    : undefined;
}

function commandScope(
  candidate: Readonly<Record<string, unknown>>,
  path: readonly string[],
): SecretCommandScope | undefined {
  const operation = secretCommandOperation(candidate["kind"]);
  if (operation !== undefined && isRecord(candidate["input"])) {
    return {
      operation,
      inputPath: [...path, "input"],
    };
  }
  const envelopeOperation = secretCommandOperation(candidate["operation"]);
  const command = candidate["command"];
  if (
    envelopeOperation !== undefined &&
    isRecord(command) &&
    command["kind"] === envelopeOperation &&
    isRecord(command["input"])
  ) {
    return {
      operation: envelopeOperation,
      inputPath: [...path, "command", "input"],
    };
  }
  return undefined;
}

function hasExactPath(
  path: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    path.length === expected.length &&
    path.every((segment, index) => segment === expected[index])
  );
}

function isSecretMaterialPath(
  path: readonly string[],
  scope: SecretCommandScope | undefined,
): boolean {
  if (scope === undefined) {
    return false;
  }
  return scope.operation === "secret.create"
    ? hasExactPath(path, [...scope.inputPath, "material", "value"])
    : hasExactPath(path, [...scope.inputPath, "replacement"]);
}

export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (
    candidate: unknown,
    path: readonly string[],
    inheritedScope?: SecretCommandScope,
  ): unknown => {
    if (candidate instanceof SecretValue) {
      return candidate.toJSON();
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      typeof candidate === "string" ||
      typeof candidate === "undefined"
    ) {
      return candidate;
    }
    if (typeof candidate !== "object") {
      return String(candidate);
    }
    if (seen.has(candidate)) {
      return "[CIRCULAR]";
    }
    seen.add(candidate);

    const localScope = isRecord(candidate)
      ? commandScope(candidate, path)
      : undefined;
    const scope = localScope ?? inheritedScope;
    const redacted = Array.isArray(candidate)
      ? candidate.map((item, index) =>
          visit(item, [...path, String(index)], scope),
        )
      : Object.fromEntries(
          Object.entries(candidate).map(([key, item]) => {
            const itemPath = [...path, key];
            return [
              key,
              item instanceof SecretValue
                ? visit(item, itemPath, scope)
                : isSensitiveFieldName(key) ||
                    isSecretMaterialPath(itemPath, scope)
                  ? REDACTED_SECRET
                  : visit(item, itemPath, scope),
            ];
          }),
        );
    seen.delete(candidate);
    return redacted;
  };

  return visit(value, []);
}
