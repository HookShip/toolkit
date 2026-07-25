// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { checkCredentialScope, type ScopedCredential } from "./context.js";
import {
  canonicalizeMetadataRecord,
  jsonValue,
  stableJson,
} from "./metadata-canonical.js";
import {
  isPlainObject,
  onlyKeys,
  sha256Pattern,
  validString,
  validateMetadataDeliveryAttemptInput,
} from "./metadata-validation.js";
import { revealSecret } from "./secret.js";
import {
  METADATA_INGEST_SCHEMA_VERSION,
  METADATA_INGEST_SIGNATURE_ALGORITHM,
  type CanonicalMetadataRecord,
  type MetadataDeliveryAttemptInput,
  type MetadataIdentity,
} from "./metadata-types.js";

export interface MetadataIngestEnvelopeContent extends MetadataIdentity {
  readonly batchFingerprint: string;
  readonly batchId: string;
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly kind: "metadata_ingest";
  readonly records: readonly MetadataDeliveryAttemptInput[];
  readonly schemaVersion: typeof METADATA_INGEST_SCHEMA_VERSION;
}

export interface AuthenticatedMetadataIngestEnvelope extends MetadataIngestEnvelopeContent {
  readonly signature: {
    readonly algorithm: typeof METADATA_INGEST_SIGNATURE_ALGORITHM;
    readonly value: string;
  };
}

export interface MetadataIngestEnvelopeOptions {
  readonly expiresAt?: number;
  readonly issuedAt?: number;
  readonly maximumLifetimeMilliseconds?: number;
}

export type MetadataIngestVerificationResult =
  | {
      readonly envelope: AuthenticatedMetadataIngestEnvelope;
      readonly ok: true;
      readonly records: readonly CanonicalMetadataRecord[];
    }
  | {
      readonly code: string;
      readonly message: string;
      readonly ok: false;
    };

function metadataBatchFingerprint(
  content: Pick<
    MetadataIngestEnvelopeContent,
    | "adapterId"
    | "batchId"
    | "connectionId"
    | "environment"
    | "records"
    | "tenantId"
  >,
): string {
  return createHash("sha256")
    .update(
      stableJson(
        jsonValue({
          tenantId: content.tenantId,
          environment: content.environment,
          adapterId: content.adapterId,
          connectionId: content.connectionId,
          batchId: content.batchId,
          records: content.records,
        }),
      ),
      "utf8",
    )
    .digest("hex");
}

function metadataSigningContent(
  content: MetadataIngestEnvelopeContent,
): string {
  return stableJson(
    jsonValue({
      kind: content.kind,
      schemaVersion: content.schemaVersion,
      tenantId: content.tenantId,
      environment: content.environment,
      adapterId: content.adapterId,
      connectionId: content.connectionId,
      credentialId: content.credentialId,
      batchId: content.batchId,
      batchFingerprint: content.batchFingerprint,
      issuedAt: content.issuedAt,
      expiresAt: content.expiresAt,
      records: content.records,
    }),
  );
}

function metadataSignature(
  content: MetadataIngestEnvelopeContent,
  credential: ScopedCredential,
): string {
  return createHmac("sha256", revealSecret(credential.secret))
    .update(metadataSigningContent(content), "utf8")
    .digest("base64url");
}

export function createAuthenticatedMetadataIngestEnvelope(
  records: readonly MetadataDeliveryAttemptInput[],
  identity: MetadataIdentity,
  batchId: string,
  credential: ScopedCredential,
  options: MetadataIngestEnvelopeOptions = {},
): AuthenticatedMetadataIngestEnvelope {
  if (records.length === 0 || records.length > 1_000 || !validString(batchId)) {
    throw new RangeError("The metadata ingest batch is invalid.");
  }
  for (const [name, value] of Object.entries(identity)) {
    if (!validString(value)) {
      throw new RangeError(`Metadata ingest identity ${name} is invalid.`);
    }
  }
  const validated = records.map((record) => {
    const result = validateMetadataDeliveryAttemptInput(record);
    if (!result.ok) {
      throw new TypeError(
        result.issues
          .map((entry) => `${entry.path}: ${entry.message}`)
          .join("; "),
      );
    }
    return result.value;
  });
  const issuedAt = options.issuedAt ?? Date.now();
  const maximumLifetime = options.maximumLifetimeMilliseconds ?? 300_000;
  const expiresAt = options.expiresAt ?? issuedAt + 60_000;
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > maximumLifetime
  ) {
    throw new RangeError("The metadata ingest lifetime is invalid.");
  }
  const fingerprintInput = {
    ...identity,
    batchId,
    records: validated,
  };
  const content: MetadataIngestEnvelopeContent = {
    kind: "metadata_ingest",
    schemaVersion: METADATA_INGEST_SCHEMA_VERSION,
    ...identity,
    credentialId: credential.id,
    batchId,
    batchFingerprint: metadataBatchFingerprint(fingerprintInput),
    issuedAt,
    expiresAt,
    records: Object.freeze(validated),
  };
  return Object.freeze({
    ...content,
    signature: Object.freeze({
      algorithm: METADATA_INGEST_SIGNATURE_ALGORITHM,
      value: metadataSignature(content, credential),
    }),
  });
}

function ingestFailure(
  code: string,
  message: string,
): MetadataIngestVerificationResult {
  return Object.freeze({ ok: false, code, message });
}

export function verifyAuthenticatedMetadataIngestEnvelope(
  value: unknown,
  credential: ScopedCredential,
  expected: MetadataIdentity,
  options: {
    readonly maximumClockSkewMilliseconds?: number;
    readonly maximumLifetimeMilliseconds?: number;
    readonly now?: number;
  } = {},
): MetadataIngestVerificationResult {
  if (
    !isPlainObject(value) ||
    !onlyKeys(
      value,
      new Set([
        "adapterId",
        "batchFingerprint",
        "batchId",
        "connectionId",
        "credentialId",
        "environment",
        "expiresAt",
        "issuedAt",
        "kind",
        "records",
        "schemaVersion",
        "signature",
        "tenantId",
      ]),
    ) ||
    value["kind"] !== "metadata_ingest" ||
    value["schemaVersion"] !== METADATA_INGEST_SCHEMA_VERSION ||
    !validString(value["tenantId"]) ||
    !validString(value["environment"]) ||
    !validString(value["adapterId"]) ||
    !validString(value["connectionId"]) ||
    !validString(value["credentialId"]) ||
    !validString(value["batchId"]) ||
    typeof value["batchFingerprint"] !== "string" ||
    !sha256Pattern.test(value["batchFingerprint"]) ||
    !Number.isSafeInteger(value["issuedAt"]) ||
    !Number.isSafeInteger(value["expiresAt"]) ||
    !Array.isArray(value["records"]) ||
    value["records"].length === 0 ||
    value["records"].length > 1_000 ||
    !isPlainObject(value["signature"]) ||
    !onlyKeys(value["signature"], new Set(["algorithm", "value"])) ||
    value["signature"]["algorithm"] !== METADATA_INGEST_SIGNATURE_ALGORITHM ||
    typeof value["signature"]["value"] !== "string"
  ) {
    return ingestFailure(
      "metadata_ingest.invalid",
      "The metadata ingest envelope is invalid.",
    );
  }
  const recordResults = value["records"].map((record) =>
    validateMetadataDeliveryAttemptInput(record),
  );
  if (recordResults.some((result) => !result.ok)) {
    return ingestFailure(
      "metadata_ingest.invalid_record",
      "The metadata ingest envelope contains an invalid record.",
    );
  }
  const records = recordResults.map((result) => {
    if (!result.ok) {
      throw new Error("Unreachable invalid metadata result.");
    }
    return result.value;
  });
  const content: MetadataIngestEnvelopeContent = {
    kind: "metadata_ingest",
    schemaVersion: METADATA_INGEST_SCHEMA_VERSION,
    tenantId: value["tenantId"],
    environment: value["environment"],
    adapterId: value["adapterId"],
    connectionId: value["connectionId"],
    credentialId: value["credentialId"],
    batchId: value["batchId"],
    batchFingerprint: value["batchFingerprint"],
    issuedAt: value["issuedAt"] as number,
    expiresAt: value["expiresAt"] as number,
    records,
  };
  const fingerprint = metadataBatchFingerprint(content);
  if (fingerprint !== content.batchFingerprint) {
    return ingestFailure(
      "metadata_ingest.fingerprint_mismatch",
      "The metadata batch fingerprint is invalid.",
    );
  }
  if (content.credentialId !== credential.id) {
    return ingestFailure(
      "metadata_ingest.credential_mismatch",
      "The metadata credential is not accepted.",
    );
  }
  const expectedSignature = Buffer.from(
    metadataSignature(content, credential),
    "base64url",
  );
  const actualSignature = Buffer.from(
    value["signature"]["value"] as string,
    "base64url",
  );
  if (
    expectedSignature.byteLength !== actualSignature.byteLength ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return ingestFailure(
      "metadata_ingest.signature_invalid",
      "The metadata ingest signature is invalid.",
    );
  }
  const now = options.now ?? Date.now();
  const skew = options.maximumClockSkewMilliseconds ?? 30_000;
  const maximumLifetime = options.maximumLifetimeMilliseconds ?? 300_000;
  if (
    content.issuedAt > now + skew ||
    content.expiresAt <= now ||
    content.expiresAt <= content.issuedAt ||
    content.expiresAt - content.issuedAt > maximumLifetime
  ) {
    return ingestFailure(
      "metadata_ingest.expired",
      "The metadata ingest envelope is expired.",
    );
  }
  for (const field of [
    "tenantId",
    "environment",
    "adapterId",
    "connectionId",
  ] as const) {
    if (content[field] !== expected[field]) {
      const code =
        field === "adapterId"
          ? "adapter"
          : field === "connectionId"
            ? "connection"
            : field;
      return ingestFailure(
        `metadata_ingest.wrong_${code}`,
        `The metadata ingest ${field} is invalid.`,
      );
    }
  }
  const scope = checkCredentialScope(credential, {
    adapterId: expected.adapterId,
    connectionId: expected.connectionId,
    environment: expected.environment,
    purpose: "metadata.ingest",
    role: "metadata_ingest",
    tenantId: expected.tenantId,
    now,
  });
  if (!scope.ok) {
    return ingestFailure(
      `metadata_ingest.${scope.reason ?? "credential_scope_mismatch"}`,
      "The metadata credential is outside its authorized scope.",
    );
  }
  const canonical = records.map((record) =>
    canonicalizeMetadataRecord(record, expected),
  );
  return Object.freeze({
    ok: true,
    envelope: Object.freeze({
      ...content,
      records: Object.freeze(records),
      signature: Object.freeze({
        algorithm: METADATA_INGEST_SIGNATURE_ALGORITHM,
        value: value["signature"]["value"] as string,
      }),
    }),
    records: Object.freeze(canonical),
  });
}
