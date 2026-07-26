// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  validateCanonicalMetadataRecord,
  validateMetadataDeliveryAttemptInput,
  type CanonicalMetadataRecord,
  type MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";
import {
  SupportEvidenceError,
  canonicalJson,
  createEvidenceBundle,
  renderEvidenceJson,
  renderEvidenceMarkdown,
  signEvidenceBundle,
  type EvidenceBundle,
  type EvidencePurpose,
  type EvidenceRecord,
  type RetryCategory,
} from "@webhook-portal/support-evidence";

import {
  booleanOption,
  parseCommandArguments,
  stringOption,
  type ParsedCommandArguments,
} from "./arguments.js";
import {
  CliCommandError,
  ensurePositionals,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { assertSingleStdinConsumer } from "./io.js";
import {
  assertAllowedKeys,
  artifactFormat,
  assertMetadataOnlyInput,
  canonicalTimestamp,
  emitArtifact,
  enumOption,
  isPlainRecord,
  looksLikeCredential,
  optionTimestamp,
  readKeyFile,
  readStructuredInput,
  requireRecord,
  requiredOption,
  type ArtifactFormat,
} from "./learning-support.js";

const DEFAULT_EVIDENCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const TIMELINE_ENVELOPE_KEYS = new Set(["command", "response"]);

const TIMELINE_PAGE_KEYS = new Set(["items", "nextCursor"]);

const TIMELINE_RECORDS_KEYS = new Set(["records"]);

const TIMELINE_ITEM_KEYS = new Set([
  "current",
  "deliveryId",
  "firstIngestedAt",
  "lastIngestedAt",
  "lateObservationCount",
  "observationCount",
  "payloadRetained",
  "reduction",
]);

type TimelineSource =
  | { readonly kind: "metadata"; readonly value: unknown }
  | { readonly kind: "page"; readonly value: unknown };

function timelineSources(input: unknown): readonly TimelineSource[] {
  assertMetadataOnlyInput(input);
  if (Array.isArray(input)) {
    if (input.length === 0 || input.length > 1000) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TIMELINE",
        "Timeline must contain between 1 and 1000 records.",
      );
    }
    return input.map((value) => ({ kind: "metadata", value }));
  }
  const record = requireRecord(input, "Timeline");
  if (Object.hasOwn(record, "records")) {
    assertAllowedKeys(record, TIMELINE_RECORDS_KEYS, "Timeline");
    if (
      !Array.isArray(record["records"]) ||
      record["records"].length === 0 ||
      record["records"].length > 1000
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TIMELINE",
        "Timeline must contain between 1 and 1000 records.",
      );
    }
    return record["records"].map((value) => ({ kind: "metadata", value }));
  }
  let page = record;
  if (Object.hasOwn(record, "response")) {
    assertAllowedKeys(record, TIMELINE_ENVELOPE_KEYS, "Timeline envelope");
    if (record["command"] !== undefined && record["command"] !== "timeline") {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TIMELINE",
        "Timeline command envelope is invalid.",
      );
    }
    page = requireRecord(record["response"], "Timeline response");
  }
  assertAllowedKeys(page, TIMELINE_PAGE_KEYS, "Timeline response");
  if (
    !Array.isArray(page["items"]) ||
    page["items"].length === 0 ||
    page["items"].length > 1000
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TIMELINE",
      "Timeline must contain between 1 and 1000 items.",
    );
  }
  return page["items"].map((value) => ({ kind: "page", value }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const SAFE_OPAQUE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:+-]*[A-Za-z0-9])?$/u;

function opaqueToken(value: string, prefix: string, maximum = 128): string {
  if (
    Buffer.byteLength(value, "utf8") <= maximum &&
    SAFE_OPAQUE_TOKEN.test(value) &&
    !looksLikeCredential(value) &&
    !/@/u.test(value)
  ) {
    return value;
  }
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}

function retryCategory(
  record: MetadataDeliveryAttemptInput | CanonicalMetadataRecord,
): RetryCategory {
  if (record.status === "delivered") return "none";
  if (record.status === "retry_scheduled") return "scheduled";
  if (record.status === "exhausted" || record.status === "cancelled") {
    return "permanent";
  }
  if (record.status === "failed") {
    return record.retryable === true ? "transient" : "unknown";
  }
  return record.status === "attempting" || record.status === "pending"
    ? "scheduled"
    : "unknown";
}

interface EvidenceCandidate {
  readonly contractReference: {
    readonly contractId: string;
    readonly version: string;
    readonly checksum: {
      readonly algorithm: "sha256";
      readonly value: string;
    };
  };
  readonly environment?: string;
  readonly record: EvidenceRecord;
  readonly sourceId: string;
  readonly sourceMaterial: unknown;
  readonly tenantId?: string;
}

function evidenceCandidate(
  record: MetadataDeliveryAttemptInput | CanonicalMetadataRecord,
  ingestedAt: string,
  sourceId: string,
  sourceMaterial: unknown,
  identity?: { readonly environment: string; readonly tenantId: string },
): EvidenceCandidate {
  const eventChecksum = record.eventVersion.schemaChecksum;
  const providerAttemptReference =
    record.providerAttemptId ?? `${record.deliveryId}:${record.attempt}`;
  const evidence: EvidenceRecord = {
    recordType: "attempt",
    sourceId,
    occurredAt: canonicalTimestamp(record.occurredAt, "occurredAt"),
    ingestedAt: canonicalTimestamp(ingestedAt, "ingestedAt"),
    eventType: opaqueToken(record.eventVersion.eventType, "event"),
    eventVersion: opaqueToken(record.eventVersion.version, "version", 64),
    providerEventRef: opaqueToken(record.deliveryId, "delivery", 256),
    providerAttemptRef: opaqueToken(providerAttemptReference, "attempt", 256),
    endpointId: opaqueToken(record.endpointId, "endpoint"),
    status: opaqueToken(record.status, "status", 64),
    ...(record.responseStatusCode === undefined
      ? {}
      : { responseCode: record.responseStatusCode }),
    ...(record.durationMilliseconds === undefined
      ? {}
      : { latencyMs: record.durationMilliseconds }),
    retryCategory: retryCategory(record),
    ...(record.traceId === undefined
      ? {}
      : { traceId: opaqueToken(record.traceId, "trace") }),
    correlationId: opaqueToken(record.deliveryId, "correlation"),
  };
  return {
    contractReference: {
      contractId: opaqueToken(record.eventId, "contract"),
      version: opaqueToken(record.eventVersion.version, "version", 64),
      checksum: { algorithm: "sha256", value: eventChecksum },
    },
    record: evidence,
    sourceId,
    sourceMaterial,
    ...(identity === undefined ? {} : identity),
  };
}

function candidatesFromTimeline(input: unknown): readonly EvidenceCandidate[] {
  return timelineSources(input).map((source) => {
    if (source.kind === "metadata") {
      const validated = validateMetadataDeliveryAttemptInput(source.value);
      if (!validated.ok) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "INVALID_TIMELINE",
          "Timeline metadata failed the closed allowlist schema.",
          validated.issues,
        );
      }
      return evidenceCandidate(
        validated.value,
        validated.value.occurredAt,
        "timeline_export",
        validated.value,
      );
    }
    const item = requireRecord(source.value, "Timeline item");
    assertAllowedKeys(item, TIMELINE_ITEM_KEYS, "Timeline item");
    const validated = validateCanonicalMetadataRecord(item["current"]);
    if (!validated.ok) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TIMELINE",
        "Timeline current metadata failed validation.",
        validated.issues,
      );
    }
    const current = validated.value;
    const ingestedAt = canonicalTimestamp(
      item["lastIngestedAt"],
      "lastIngestedAt",
    );
    const sourceId = `source_${sha256(
      `${current.adapterId}\u0000${current.connectionId}`,
    ).slice(0, 24)}`;
    return evidenceCandidate(current, ingestedAt, sourceId, item, {
      environment: current.environment,
      tenantId: current.tenantId,
    });
  });
}

function identifierMatches(identifier: unknown, actual: string): boolean {
  if (!isPlainRecord(identifier)) {
    return false;
  }
  if (identifier["kind"] === "opaque") {
    return identifier["value"] === actual;
  }
  return (
    identifier["kind"] === "hashed" &&
    identifier["algorithm"] === "sha256" &&
    identifier["value"] === sha256(actual)
  );
}

function assertScopeMatches(
  scope: unknown,
  candidates: readonly EvidenceCandidate[],
): void {
  const identities = candidates.filter(
    (
      candidate,
    ): candidate is EvidenceCandidate & {
      readonly environment: string;
      readonly tenantId: string;
    } =>
      candidate.environment !== undefined && candidate.tenantId !== undefined,
  );
  if (identities.length === 0) {
    return;
  }
  if (!isPlainRecord(scope)) {
    return;
  }
  if (
    identities.some(
      (candidate) => !identifierMatches(scope["tenantId"], candidate.tenantId),
    )
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "EVIDENCE_SCOPE_MISMATCH",
      "Timeline tenant metadata does not match the supplied scope.",
    );
  }
  if (
    scope["environmentId"] !== undefined &&
    identities.some(
      (candidate) =>
        !identifierMatches(scope["environmentId"], candidate.environment),
    )
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "EVIDENCE_SCOPE_MISMATCH",
      "Timeline environment metadata does not match the supplied scope.",
    );
  }
}

function evidenceArtifact(
  bundle: EvidenceBundle,
  format: ArtifactFormat,
): string {
  const signatureStatus =
    bundle.signature === undefined ? "unsigned" : "signed";
  if (format === "markdown") {
    return renderEvidenceMarkdown(bundle).replace(
      "## Integrity\n\n",
      `## Integrity\n\n- Signature status: ${signatureStatus}\n`,
    );
  }
  const rendered = JSON.parse(renderEvidenceJson(bundle)) as Record<
    string,
    unknown
  >;
  return `${JSON.stringify({ ...rendered, signatureStatus }, null, 2)}\n`;
}

function forbiddenLiteralKeyArgument(args: readonly string[]): boolean {
  return args.some(
    (argument) =>
      argument === "--signing-key" ||
      argument.startsWith("--signing-key=") ||
      argument === "--private-key" ||
      argument.startsWith("--private-key="),
  );
}

interface SupportEvidenceInputs {
  readonly keyId: string | undefined;
  readonly parsed: ParsedCommandArguments;
  readonly scopePath: string;
  readonly signingKeyPath: string | undefined;
  readonly timelinePath: string;
}

interface EvidenceSelection {
  readonly from: string;
  readonly scope: unknown;
  readonly selected: readonly EvidenceCandidate[];
  readonly to: string;
}

function parseSupportEvidenceInputs(
  args: readonly string[],
): SupportEvidenceInputs {
  if (forbiddenLiteralKeyArgument(args)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "LITERAL_KEY_FORBIDDEN",
      "Private key material is accepted only through --signing-key-file.",
    );
  }
  const parsed = parseCommandArguments(args, {
    "case-id": { type: "string" },
    scope: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    purpose: { type: "string" },
    "expires-at": { type: "string" },
    "signing-key-file": { type: "string" },
    "key-id": { type: "string" },
    format: { type: "string" },
    out: { type: "string", short: "o" },
  });
  ensurePositionals(parsed.positionals, 1);
  const timelinePath = parsed.positionals[0]!;
  const scopePath = requiredOption(parsed.values, "scope");
  const signingKeyPath = stringOption(parsed.values, "signing-key-file");
  const keyId = stringOption(parsed.values, "key-id");
  if (signingKeyPath === "-") {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "KEY_STDIN_FORBIDDEN",
      "Private keys must be read from a permission-restricted file, not stdin.",
    );
  }
  if ((signingKeyPath === undefined) !== (keyId === undefined)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "INCOMPLETE_SIGNING_OPTIONS",
      "--signing-key-file and --key-id must be provided together.",
    );
  }
  assertSingleStdinConsumer([
    { name: "timeline", usesStdin: timelinePath === "-" },
    { name: "scope", usesStdin: scopePath === "-" },
  ]);
  return { keyId, parsed, scopePath, signingKeyPath, timelinePath };
}

async function selectEvidenceRecords(
  parsed: ParsedCommandArguments,
  timelinePath: string,
  scopePath: string,
  dependencies: CliDependencies,
): Promise<EvidenceSelection> {
  const timeline = await readStructuredInput(
    timelinePath,
    "support timeline",
    dependencies,
  );
  const scope = await readStructuredInput(
    scopePath,
    "support scope",
    dependencies,
  );
  const candidates = candidatesFromTimeline(timeline);
  const inferredFrom = candidates.reduce((minimum, candidate) => {
    const value = Date.parse(candidate.record.occurredAt);
    return Math.min(minimum, value);
  }, Number.POSITIVE_INFINITY);
  const inferredTo = candidates.reduce((maximum, candidate) => {
    return Math.max(
      maximum,
      Date.parse(candidate.record.occurredAt),
      Date.parse(candidate.record.ingestedAt),
    );
  }, Number.NEGATIVE_INFINITY);
  const from =
    optionTimestamp(parsed.values, "from") ??
    new Date(inferredFrom).toISOString();
  const explicitTo = optionTimestamp(parsed.values, "to");
  const to =
    explicitTo ??
    new Date(
      inferredTo <= inferredFrom ? inferredFrom + 1 : inferredTo,
    ).toISOString();
  if (Date.parse(to) <= Date.parse(from)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_EVIDENCE_RANGE",
      "Evidence --to must be after --from.",
    );
  }
  const selected = candidates.filter((candidate) => {
    const occurredAt = Date.parse(candidate.record.occurredAt);
    return occurredAt >= Date.parse(from) && occurredAt <= Date.parse(to);
  });
  if (selected.length === 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "EMPTY_EVIDENCE",
      "The selected time range contains no timeline records.",
    );
  }
  assertScopeMatches(scope, selected);
  return { from, scope, selected, to };
}

function evidenceCommandNow(dependencies: CliDependencies): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.valueOf())) {
    throw new CliCommandError(
      CLI_EXIT_CODES.runtime,
      "CLOCK_INVALID",
      "The command clock returned an invalid time.",
    );
  }
  return now;
}

function createSupportEvidenceBundle(
  parsed: ParsedCommandArguments,
  scope: unknown,
  selected: readonly EvidenceCandidate[],
  from: string,
  to: string,
  createdAt: string,
  expiresAt: string,
): EvidenceBundle {
  const groupedSources = new Map<
    string,
    { readonly material: unknown[]; count: number }
  >();
  for (const candidate of selected) {
    const group = groupedSources.get(candidate.sourceId) ?? {
      material: [],
      count: 0,
    };
    group.material.push(candidate.sourceMaterial);
    group.count += 1;
    groupedSources.set(candidate.sourceId, group);
  }
  const contractReferences = [
    ...new Map(
      selected.map((candidate) => [
        canonicalJson(candidate.contractReference),
        candidate.contractReference,
      ]),
    ).values(),
  ];
  try {
    return createEvidenceBundle({
      supportCaseId: requiredOption(parsed.values, "case-id"),
      tenantScope: scope,
      selection: {
        from,
        to,
        purpose: enumOption(
          parsed.values,
          "purpose",
          [
            "case-review",
            "contract-verification",
            "delivery-verification",
            "incident-correlation",
            "provider-escalation",
            "timeline-review",
          ] as const satisfies readonly EvidencePurpose[],
          "case-review",
        ),
      },
      records: selected.map((candidate) => candidate.record),
      contractReferences,
      sources: [...groupedSources.entries()].map(([sourceId, source]) => ({
        sourceId,
        checksum: {
          algorithm: "sha256" as const,
          value: sha256(canonicalJson(source.material)),
        },
        recordCount: source.count,
      })),
      createdAt,
      expiresAt,
    });
  } catch (error) {
    if (error instanceof SupportEvidenceError) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        error.code,
        "Support evidence input failed metadata-only validation.",
        { path: error.path },
      );
    }
    throw error;
  }
}

async function signSupportEvidenceBundle(
  bundle: EvidenceBundle,
  signingKeyPath: string | undefined,
  keyId: string | undefined,
  dependencies: CliDependencies,
  createdAt: string,
): Promise<EvidenceBundle> {
  if (signingKeyPath !== undefined && keyId !== undefined) {
    const privateKey = await readKeyFile(
      signingKeyPath,
      dependencies.cwd,
      "private",
    );
    try {
      return signEvidenceBundle(bundle, {
        keyId,
        privateKey,
        signedAt: createdAt,
      });
    } catch (error) {
      if (error instanceof SupportEvidenceError) {
        throw new CliCommandError(
          CLI_EXIT_CODES.security,
          error.code,
          "Support evidence signing failed.",
          { path: error.path },
        );
      }
      throw error;
    }
  }
  return bundle;
}

async function emitSupportEvidenceBundle(
  parsed: ParsedCommandArguments,
  dependencies: CliDependencies,
  bundle: EvidenceBundle,
): Promise<void> {
  const format = artifactFormat(parsed.values, "json");
  const signatureStatus =
    bundle.signature === undefined ? "unsigned" : "signed";
  const outputPath = stringOption(parsed.values, "out");
  await emitArtifact(dependencies, {
    content: evidenceArtifact(bundle, format),
    envelope: {
      command: "support-evidence",
      format,
      status: signatureStatus,
      digest: bundle.digest,
      bundle,
    },
    humanSummary: [
      `Evidence digest: ${bundle.digest}`,
      `Signature status: ${signatureStatus}`,
      `Records: ${bundle.snapshot.recordCount}`,
    ],
    json: booleanOption(parsed.values, "json"),
    ...(outputPath === undefined ? {} : { outputPath }),
  });
}

export async function supportEvidenceCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const { keyId, parsed, scopePath, signingKeyPath, timelinePath } =
    parseSupportEvidenceInputs(args);
  const { from, scope, selected, to } = await selectEvidenceRecords(
    parsed,
    timelinePath,
    scopePath,
    dependencies,
  );
  const now = evidenceCommandNow(dependencies);
  const createdAt = now.toISOString();
  const expiresAt =
    optionTimestamp(parsed.values, "expires-at") ??
    new Date(now.valueOf() + DEFAULT_EVIDENCE_LIFETIME_MS).toISOString();

  const bundle = await signSupportEvidenceBundle(
    createSupportEvidenceBundle(
      parsed,
      scope,
      selected,
      from,
      to,
      createdAt,
      expiresAt,
    ),
    signingKeyPath,
    keyId,
    dependencies,
    createdAt,
  );
  await emitSupportEvidenceBundle(parsed, dependencies, bundle);
  return CLI_EXIT_CODES.success;
}
