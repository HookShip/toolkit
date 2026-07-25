// SPDX-License-Identifier: Apache-2.0

import {
  compareUtf16CodeUnits,
  redactSecrets,
} from "@webhook-portal/adapter-sdk";

import {
  AdapterConformanceError,
  type AdapterConformanceFixture,
} from "./types.js";

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AdapterConformanceError(message);
  }
}

export async function resetFixture(
  fixture: AdapterConformanceFixture,
): Promise<void> {
  await fixture.reset?.();
  await fixture.sideEffects?.reset();
}

export function stableValue(value: unknown): string {
  return canonicalValue(redactSecrets(value));
}

export function canonicalValue(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return candidate.map((item) => normalize(item));
    }
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}
