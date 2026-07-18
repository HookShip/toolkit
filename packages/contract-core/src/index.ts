// SPDX-License-Identifier: Apache-2.0

import type { ContractCore } from "./api-types.js";
import { diffContracts } from "./diff.js";
import { generateFixture } from "./fixtures.js";
import {
  canonicalizeContract,
  computeCanonicalChecksum,
  validateContract,
} from "./normalize.js";
import { parseContract } from "./parser.js";
import { generateTypeScript } from "./typegen.js";

export * from "@webhook-portal/canonical-model";
export * from "./api-types.js";
export * from "./diff.js";
export * from "./fixtures.js";
export * from "./limits.js";
export * from "./normalize.js";
export * from "./parser.js";
export { resolveJsonPointer } from "./refs.js";
export * from "./typegen.js";

export const parse = parseContract;
export const validate = validateContract;
export const canonicalize = canonicalizeContract;
export const checksum = computeCanonicalChecksum;
export const diff = diffContracts;
export const fixtures = generateFixture;
export const types = generateTypeScript;

export const contractCore: ContractCore = Object.freeze({
  canonicalize: canonicalizeContract,
  checksum: computeCanonicalChecksum,
  diff: diffContracts,
  fixtures: generateFixture,
  parse: parseContract,
  types: generateTypeScript,
  validate: validateContract,
});
