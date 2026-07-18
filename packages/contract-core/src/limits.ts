// SPDX-License-Identifier: Apache-2.0

import type { ContractLimits } from "./api-types.js";

export const DEFAULT_CONTRACT_LIMITS: ContractLimits = Object.freeze({
  maxAliases: 32,
  maxDepth: 64,
  maxDiagnostics: 100,
  maxEvents: 1_000,
  maxExamplesPerEvent: 100,
  maxInputBytes: 2 * 1024 * 1024,
  maxNodes: 100_000,
  maxOutputBytes: 512 * 1024,
  maxOutputNodes: 50_000,
  maxPropertiesPerObject: 10_000,
  maxReferences: 2_000,
  maxStringBytes: 512 * 1024,
  maxValidationOperations: 250_000,
});

const positiveIntegerKeys = Object.keys(
  DEFAULT_CONTRACT_LIMITS,
) as (keyof ContractLimits)[];

function boundedDouble(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * 2);
}

export function resolveLimits(
  overrides: Partial<ContractLimits> | undefined,
): ContractLimits {
  const resolved = {
    ...DEFAULT_CONTRACT_LIMITS,
    ...overrides,
    ...(overrides?.maxOutputBytes === undefined &&
    overrides?.maxInputBytes !== undefined
      ? { maxOutputBytes: boundedDouble(overrides.maxInputBytes) }
      : {}),
    ...(overrides?.maxOutputNodes === undefined &&
    overrides?.maxNodes !== undefined
      ? { maxOutputNodes: boundedDouble(overrides.maxNodes) }
      : {}),
  };

  for (const key of positiveIntegerKeys) {
    const value = resolved[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${key} must be a positive safe integer`);
    }
  }

  return resolved;
}
