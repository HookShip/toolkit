// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  canonicalJsonDigest,
  cloneJson,
  type JsonValue,
} from "./canonical.js";
import { DeclarativeRuntimeError } from "./errors.js";
import {
  getJsonPointer,
  normalizeJsonPointer,
  parseJsonPointer,
  setJsonPointer,
} from "./json-pointer.js";
import {
  assertPermissionSetContains,
  normalizePermissionSet,
  type PermissionSet,
} from "./permissions.js";
import {
  expectEnum,
  expectInteger,
  expectString,
  inspectArray,
  inspectClosedObject,
} from "./validation.js";

export const POLICY_DSL_VERSION = "1.0" as const;
export const DATA_CLASSIFICATIONS = [
  "confidential",
  "internal",
  "personal",
  "public",
  "restricted",
] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];
export type PolicyTarget = "metadata" | "payload";

interface PolicyRuleBase {
  readonly path: string;
  readonly target: PolicyTarget;
}

export interface RequirePolicyRule extends PolicyRuleBase {
  readonly op: "require";
}

export interface DenyPolicyRule extends PolicyRuleBase {
  readonly op: "deny";
}

export interface RedactPolicyRule extends PolicyRuleBase {
  readonly op: "redact";
  readonly replacement: string;
}

export interface HashPolicyRule extends PolicyRuleBase {
  readonly op: "hash";
}

export interface ClassifyPolicyRule extends PolicyRuleBase {
  readonly classification: DataClassification;
  readonly op: "classify";
}

export type PolicyRule =
  | ClassifyPolicyRule
  | DenyPolicyRule
  | HashPolicyRule
  | RedactPolicyRule
  | RequirePolicyRule;

export interface PolicyProgram {
  readonly rules: readonly PolicyRule[];
  readonly version: typeof POLICY_DSL_VERSION;
}

export interface PolicyRuntimeLimits {
  readonly maximumDepth?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumRules?: number;
  readonly maximumSteps?: number;
}

export const HARD_POLICY_LIMITS = Object.freeze({
  maximumDepth: 32,
  maximumOutputBytes: 1024 * 1024,
  maximumRules: 128,
  maximumSteps: 20_000,
});

export interface PolicyFinding {
  readonly classification?: DataClassification;
  readonly code:
    | "field_classified"
    | "field_denied"
    | "field_hashed"
    | "field_redacted"
    | "required_field_missing";
  readonly path: string;
  readonly ruleIndex: number;
  readonly severity: "error" | "info";
  readonly target: PolicyTarget;
}

export interface PolicyResult {
  readonly decision: "allow" | "deny";
  readonly findings: readonly PolicyFinding[];
  readonly metadata: JsonValue;
  readonly payload?: JsonValue;
}

function boundedLimits(limits: PolicyRuntimeLimits = {}) {
  const limit = (
    value: number | undefined,
    hard: number,
    path: string,
  ): number =>
    value === undefined ? hard : expectInteger(value, path, 1, hard);
  return Object.freeze({
    maximumDepth: limit(
      limits.maximumDepth,
      HARD_POLICY_LIMITS.maximumDepth,
      "limits.maximumDepth",
    ),
    maximumOutputBytes: limit(
      limits.maximumOutputBytes,
      HARD_POLICY_LIMITS.maximumOutputBytes,
      "limits.maximumOutputBytes",
    ),
    maximumRules: limit(
      limits.maximumRules,
      HARD_POLICY_LIMITS.maximumRules,
      "limits.maximumRules",
    ),
    maximumSteps: limit(
      limits.maximumSteps,
      HARD_POLICY_LIMITS.maximumSteps,
      "limits.maximumSteps",
    ),
  });
}

function parseRule(
  value: unknown,
  index: number,
  limits: ReturnType<typeof boundedLimits>,
): PolicyRule {
  const path = `program.rules[${index}]`;
  const header = inspectClosedObject(
    value,
    path,
    ["op", "target", "path"],
    ["classification", "replacement"],
  );
  const op = expectEnum(header.op, `${path}.op`, [
    "classify",
    "deny",
    "hash",
    "redact",
    "require",
  ] as const);
  const target = expectEnum(header.target, `${path}.target`, [
    "metadata",
    "payload",
  ] as const);
  const pointer = normalizeJsonPointer(
    expectString(header.path, `${path}.path`),
    `${path}.path`,
  );
  parseJsonPointer(pointer, `${path}.path`, limits.maximumDepth);
  switch (op) {
    case "classify": {
      const object = inspectClosedObject(value, path, [
        "op",
        "target",
        "path",
        "classification",
      ]);
      return Object.freeze({
        op,
        target,
        path: pointer,
        classification: expectEnum(
          object.classification,
          `${path}.classification`,
          DATA_CLASSIFICATIONS,
        ),
      });
    }
    case "redact": {
      const object = inspectClosedObject(
        value,
        path,
        ["op", "target", "path"],
        ["replacement"],
      );
      return Object.freeze({
        op,
        target,
        path: pointer,
        replacement:
          object.replacement === undefined
            ? "[REDACTED]"
            : expectString(object.replacement, `${path}.replacement`, {
                allowEmpty: true,
                maximumLength: 256,
              }),
      });
    }
    case "deny":
    case "hash":
    case "require":
      inspectClosedObject(value, path, ["op", "target", "path"]);
      return Object.freeze({ op, target, path: pointer });
  }
}

export function parsePolicyProgram(
  value: unknown,
  runtimeLimits: PolicyRuntimeLimits = {},
): PolicyProgram {
  const limits = boundedLimits(runtimeLimits);
  const object = inspectClosedObject(value, "program", ["version", "rules"]);
  const version = expectEnum(object.version, "program.version", [
    POLICY_DSL_VERSION,
  ] as const);
  const rules = inspectArray(
    object.rules,
    "program.rules",
    limits.maximumRules,
  ).map((candidate, index) => parseRule(candidate, index, limits));
  if (rules.length === 0) {
    throw new DeclarativeRuntimeError(
      "EMPTY_PROGRAM",
      "Policy program must contain at least one rule.",
      "program.rules",
    );
  }
  return Object.freeze({ version, rules: Object.freeze(rules) });
}

export function analyzePolicyPermissions(
  value: unknown,
  limits: PolicyRuntimeLimits = {},
): PermissionSet {
  const program = parsePolicyProgram(value, limits);
  const metadataRead = new Set<string>();
  const metadataWrite = new Set<string>();
  const payloadRead = new Set<string>();
  const payloadWrite = new Set<string>();
  for (const rule of program.rules) {
    const read = rule.target === "metadata" ? metadataRead : payloadRead;
    const write = rule.target === "metadata" ? metadataWrite : payloadWrite;
    read.add(rule.path);
    if (rule.op === "hash" || rule.op === "redact") {
      write.add(rule.path);
    }
  }
  return normalizePermissionSet({
    metadataRead: [...metadataRead],
    metadataWrite: [...metadataWrite],
    payloadRead: [...payloadRead],
    payloadWrite: [...payloadWrite],
  });
}

function finding(
  rule: PolicyRule,
  ruleIndex: number,
  code: PolicyFinding["code"],
  severity: PolicyFinding["severity"],
): PolicyFinding {
  return Object.freeze({
    code,
    path: rule.path,
    ruleIndex,
    severity,
    target: rule.target,
    ...(rule.op === "classify" ? { classification: rule.classification } : {}),
  });
}

export function runPolicy(
  programInput: unknown,
  input: {
    readonly metadata: JsonValue;
    readonly payload?: JsonValue;
  },
  options: {
    readonly limits?: PolicyRuntimeLimits;
    readonly permissions?: unknown;
  } = {},
): PolicyResult {
  const limits = boundedLimits(options.limits);
  const program = parsePolicyProgram(programInput, limits);
  const required = analyzePolicyPermissions(program, limits);
  assertPermissionSetContains(
    normalizePermissionSet(options.permissions ?? {}),
    required,
  );
  canonicalJson(input.metadata, {
    maximumDepth: limits.maximumDepth,
    maximumOutputBytes: limits.maximumOutputBytes,
  });
  if (input.payload !== undefined) {
    canonicalJson(input.payload, {
      maximumDepth: limits.maximumDepth,
      maximumOutputBytes: limits.maximumOutputBytes,
    });
  }
  const metadata = cloneJson(input.metadata);
  const payload =
    input.payload === undefined ? undefined : cloneJson(input.payload);
  const findings: PolicyFinding[] = [];
  let decision: "allow" | "deny" = "allow";
  let steps = 0;
  const tick = (path: string): void => {
    steps += parseJsonPointer(path).length + 1;
    if (steps > limits.maximumSteps) {
      throw new DeclarativeRuntimeError(
        "STEP_LIMIT",
        "Policy runtime step limit exceeded.",
      );
    }
  };

  for (let ruleIndex = 0; ruleIndex < program.rules.length; ruleIndex += 1) {
    const rule = program.rules[ruleIndex];
    if (rule === undefined) {
      continue;
    }
    tick(rule.path);
    const target = rule.target === "metadata" ? metadata : payload;
    const lookup =
      target === undefined
        ? { found: false as const }
        : getJsonPointer(target, rule.path);
    switch (rule.op) {
      case "require":
        if (!lookup.found || lookup.value === null) {
          findings.push(
            finding(rule, ruleIndex, "required_field_missing", "error"),
          );
          decision = "deny";
        }
        break;
      case "deny":
        if (lookup.found) {
          findings.push(finding(rule, ruleIndex, "field_denied", "error"));
          decision = "deny";
        }
        break;
      case "redact":
        if (lookup.found && target !== undefined) {
          setJsonPointer(target, rule.path, rule.replacement);
          findings.push(finding(rule, ruleIndex, "field_redacted", "info"));
        }
        break;
      case "hash":
        if (lookup.found && target !== undefined) {
          setJsonPointer(
            target,
            rule.path,
            canonicalJsonDigest(lookup.value as JsonValue),
          );
          findings.push(finding(rule, ruleIndex, "field_hashed", "info"));
        }
        break;
      case "classify":
        if (lookup.found) {
          findings.push(finding(rule, ruleIndex, "field_classified", "info"));
        }
        break;
    }
  }
  const output = {
    decision,
    findings: Object.freeze(findings),
    metadata,
    ...(payload === undefined ? {} : { payload }),
  } satisfies PolicyResult;
  canonicalJson(output.metadata, {
    maximumDepth: limits.maximumDepth,
    maximumOutputBytes: limits.maximumOutputBytes,
  });
  if (output.payload !== undefined) {
    canonicalJson(output.payload, {
      maximumDepth: limits.maximumDepth,
      maximumOutputBytes: limits.maximumOutputBytes,
    });
  }
  return Object.freeze(output);
}
