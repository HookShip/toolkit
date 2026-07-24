// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  SupportEvidenceError,
  parseEvidenceBundle,
  verifyEvidenceBundle,
  type EvidenceBundle,
  type EvidenceVerificationPolicy,
  type TrustedEvidenceKey,
} from "@webhook-portal/support-evidence";

import {
  booleanOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import {
  CliCommandError,
  commandOutput,
  ensurePositionals,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { assertSingleStdinConsumer } from "./io.js";
import {
  assertAllowedKeys,
  assertMetadataOnlyInput,
  assertNoCredentialValues,
  canonicalTimestamp,
  isPlainRecord,
  nonNegativeInteger,
  optionalBoolean,
  optionalInteger,
  optionTimestamp,
  readKeyFile,
  readStructuredInput,
  requireRecord,
  safeString,
} from "./learning-support.js";
import { emitSuccess } from "./output.js";

function normalizeEvidenceArtifact(input: unknown): unknown {
  if (!isPlainRecord(input)) {
    return input;
  }
  assertMetadataOnlyInput(input);
  if (isPlainRecord(input["bundle"])) {
    assertAllowedKeys(
      input,
      new Set(["bundle", "command", "digest", "format", "output", "status"]),
      "Evidence command envelope",
    );
    if (input["command"] !== "support-evidence") {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_EVIDENCE_BUNDLE",
        "Evidence command envelope is invalid.",
      );
    }
    return input["bundle"];
  }
  if (
    isPlainRecord(input["evidence"]) &&
    isPlainRecord(input["integrity"]) &&
    typeof input["integrity"]["digest"] === "string"
  ) {
    assertAllowedKeys(
      input,
      new Set([
        "evidence",
        "format",
        "integrity",
        "limitations",
        "signatureStatus",
        "version",
      ]),
      "Evidence artifact",
    );
    return {
      snapshot: input["evidence"],
      digest: input["integrity"]["digest"],
      ...(input["integrity"]["signature"] === null ||
      input["integrity"]["signature"] === undefined
        ? {}
        : { signature: input["integrity"]["signature"] }),
    };
  }
  return input;
}

const TRUST_POLICY_KEYS = new Set([
  "allowHistoricalSignatures",
  "keys",
  "maximumClockSkewMs",
  "requireSignature",
]);

const TRUST_KEY_KEYS = new Set([
  "keyId",
  "publicKeyFile",
  "revocationMode",
  "revokedAt",
  "validFrom",
  "validUntil",
]);

async function trustPolicyFromFile(
  value: string,
  dependencies: CliDependencies,
): Promise<EvidenceVerificationPolicy> {
  const parsed = await readStructuredInput(
    value,
    "support evidence trust policy",
    dependencies,
  );
  assertNoCredentialValues(parsed);
  const record = requireRecord(parsed, "Trust policy");
  assertAllowedKeys(record, TRUST_POLICY_KEYS, "Trust policy");
  if (!Array.isArray(record["keys"]) || record["keys"].length > 100) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TRUST_POLICY",
      "Trust policy keys must be a bounded array.",
    );
  }
  const baseDirectory =
    value === "-"
      ? dependencies.cwd
      : path.dirname(path.resolve(dependencies.cwd, value));
  const keys: TrustedEvidenceKey[] = [];
  for (const raw of record["keys"]) {
    const key = requireRecord(raw, "Trust policy key");
    assertAllowedKeys(key, TRUST_KEY_KEYS, "Trust policy key");
    const revocationMode = key["revocationMode"];
    if (
      revocationMode !== undefined &&
      revocationMode !== "all" &&
      revocationMode !== "from-time"
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TRUST_POLICY",
        "Trust policy revocation mode is invalid.",
      );
    }
    keys.push({
      keyId: safeString(key["keyId"], "Trust key ID", 128),
      publicKey: await readKeyFile(
        safeString(key["publicKeyFile"], "Public key file", 2048),
        baseDirectory,
        "public",
      ),
      ...(key["validFrom"] === undefined
        ? {}
        : {
            validFrom: canonicalTimestamp(
              key["validFrom"],
              "Trust key validFrom",
            ),
          }),
      ...(key["validUntil"] === undefined
        ? {}
        : {
            validUntil: canonicalTimestamp(
              key["validUntil"],
              "Trust key validUntil",
            ),
          }),
      ...(key["revokedAt"] === undefined
        ? {}
        : {
            revokedAt: canonicalTimestamp(
              key["revokedAt"],
              "Trust key revokedAt",
            ),
          }),
      ...(revocationMode === undefined ? {} : { revocationMode }),
    });
  }
  const requireSignature = optionalBoolean(
    record["requireSignature"],
    "requireSignature",
  );
  const allowHistoricalSignatures = optionalBoolean(
    record["allowHistoricalSignatures"],
    "allowHistoricalSignatures",
  );
  const maximumClockSkewMs =
    record["maximumClockSkewMs"] === undefined
      ? undefined
      : nonNegativeInteger(record["maximumClockSkewMs"], "maximumClockSkewMs");
  return {
    keys,
    ...(requireSignature === undefined ? {} : { requireSignature }),
    ...(allowHistoricalSignatures === undefined
      ? {}
      : { allowHistoricalSignatures }),
    ...(maximumClockSkewMs === undefined ? {} : { maximumClockSkewMs }),
  };
}

export async function supportEvidenceVerifyCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    "public-key-file": { type: "string" },
    "trust-policy": { type: "string" },
    "key-id": { type: "string" },
    "valid-from": { type: "string" },
    "valid-until": { type: "string" },
    "revoked-at": { type: "string" },
    "revocation-mode": { type: "string" },
    "require-signature": { type: "boolean" },
    "allow-historical-signatures": { type: "boolean" },
    now: { type: "string" },
    "max-clock-skew-ms": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 1);
  const bundlePath = parsed.positionals[0]!;
  const trustPolicyPath = stringOption(parsed.values, "trust-policy");
  const publicKeyPath = stringOption(parsed.values, "public-key-file");
  if (publicKeyPath === "-") {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "KEY_STDIN_FORBIDDEN",
      "Public keys must be read from a file, not stdin.",
    );
  }
  assertSingleStdinConsumer([
    { name: "evidence bundle", usesStdin: bundlePath === "-" },
    { name: "trust policy", usesStdin: trustPolicyPath === "-" },
  ]);
  const normalized = normalizeEvidenceArtifact(
    await readStructuredInput(
      bundlePath,
      "support evidence bundle",
      dependencies,
    ),
  );
  let policy: EvidenceVerificationPolicy =
    trustPolicyPath === undefined
      ? {}
      : await trustPolicyFromFile(trustPolicyPath, dependencies);
  if (publicKeyPath !== undefined) {
    let bundle: EvidenceBundle | undefined;
    try {
      bundle = parseEvidenceBundle(normalized);
    } catch {
      bundle = undefined;
    }
    const keyId =
      stringOption(parsed.values, "key-id") ?? bundle?.signature?.keyId;
    if (keyId === undefined) {
      throw new CliCommandError(
        CLI_EXIT_CODES.usage,
        "KEY_ID_REQUIRED",
        "--key-id is required when the bundle has no usable signature key ID.",
      );
    }
    const revocationMode = stringOption(parsed.values, "revocation-mode");
    if (
      revocationMode !== undefined &&
      revocationMode !== "all" &&
      revocationMode !== "from-time"
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.usage,
        "INVALID_OPTION",
        "--revocation-mode must be all or from-time.",
      );
    }
    const validFrom = optionTimestamp(parsed.values, "valid-from");
    const validUntil = optionTimestamp(parsed.values, "valid-until");
    const revokedAt = optionTimestamp(parsed.values, "revoked-at");
    const key: TrustedEvidenceKey = {
      keyId,
      publicKey: await readKeyFile(publicKeyPath, dependencies.cwd, "public"),
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(validUntil === undefined ? {} : { validUntil }),
      ...(revokedAt === undefined ? {} : { revokedAt }),
      ...(revocationMode === undefined
        ? {}
        : {
            revocationMode: revocationMode as "all" | "from-time",
          }),
    };
    policy = { ...policy, keys: [...(policy.keys ?? []), key] };
  } else if (
    stringOption(parsed.values, "key-id") !== undefined ||
    optionTimestamp(parsed.values, "valid-from") !== undefined ||
    optionTimestamp(parsed.values, "valid-until") !== undefined ||
    optionTimestamp(parsed.values, "revoked-at") !== undefined ||
    stringOption(parsed.values, "revocation-mode") !== undefined
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "PUBLIC_KEY_REQUIRED",
      "Key validity and revocation options require --public-key-file.",
    );
  }
  const maximumClockSkewMs = optionalInteger(
    parsed.values,
    "max-clock-skew-ms",
    0,
    24 * 60 * 60 * 1000,
  );
  const verificationTime = optionTimestamp(parsed.values, "now");
  policy = {
    ...policy,
    ...(booleanOption(parsed.values, "require-signature")
      ? { requireSignature: true }
      : {}),
    ...(booleanOption(parsed.values, "allow-historical-signatures")
      ? { allowHistoricalSignatures: true }
      : {}),
    ...(verificationTime === undefined ? {} : { now: verificationTime }),
    ...(maximumClockSkewMs === undefined ? {} : { maximumClockSkewMs }),
  };
  let result;
  try {
    result = verifyEvidenceBundle(normalized, policy);
  } catch (error) {
    if (error instanceof SupportEvidenceError) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        error.code,
        "Support evidence verification policy is invalid.",
        { path: error.path },
      );
    }
    throw error;
  }
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "support-evidence-verify", ...result },
    [
      `Integrity: ${result.integrity}`,
      `Expiry: ${result.expiry}`,
      `Signature: ${result.signature}`,
      `Valid: ${String(result.valid)}`,
    ],
  );
  if (result.integrity === "malformed") {
    return CLI_EXIT_CODES.invalid;
  }
  return result.valid ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.security;
}
