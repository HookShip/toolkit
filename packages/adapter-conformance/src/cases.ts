// SPDX-License-Identifier: Apache-2.0

import { inspect } from "node:util";

import {
  ADAPTER_OPERATIONS,
  REDACTED_SECRET,
  SecretValue,
  isSideEffectingOperation,
  redactSecrets,
  reduceDeliveryAttempt,
  validateCanonicalMetadataRecord,
  type AdapterCommand,
  type AdapterOperation,
} from "@webhook-portal/adapter-sdk";

import { ensure, resetFixture, stableValue } from "./assertions.js";
import { validateCapabilityDocument } from "./capability-document.js";
import { defaultMetadata, deriveMetadata } from "./metadata.js";
import { validateOperationResult } from "./operation-result.js";
import {
  AdapterConformanceError,
  type AdapterConformanceCase,
  type AdapterConformanceFixture,
  type AdapterConformanceReport,
  type ConformanceCaseResult,
  type ConformanceTestRunner,
  type SecretConformanceProbe,
} from "./types.js";

function supportedOperations(
  fixture: AdapterConformanceFixture,
): readonly AdapterOperation[] {
  if (
    validateCapabilityDocument(fixture.adapter.capabilityDocument).length > 0
  ) {
    return [];
  }
  return ADAPTER_OPERATIONS.filter((operation) => {
    const status =
      fixture.adapter.capabilityDocument.capabilities[operation].status;
    return status === "supported" || status === "degraded";
  });
}

function unsupportedOperations(
  fixture: AdapterConformanceFixture,
): readonly AdapterOperation[] {
  if (
    validateCapabilityDocument(fixture.adapter.capabilityDocument).length > 0
  ) {
    return [];
  }
  return ADAPTER_OPERATIONS.filter(
    (operation) =>
      fixture.adapter.capabilityDocument.capabilities[operation].status ===
      "unsupported",
  );
}

function supportedSideEffects(
  fixture: AdapterConformanceFixture,
): readonly AdapterOperation[] {
  return supportedOperations(fixture).filter((operation) =>
    isSideEffectingOperation(operation),
  );
}

function secretCases(
  fixture: AdapterConformanceFixture,
): readonly SecretConformanceProbe[] {
  return (
    fixture.secrets ?? [
      {
        plaintext: "adapter-conformance-secret-7d43f6",
        secret: new SecretValue("adapter-conformance-secret-7d43f6"),
      },
    ]
  );
}

function withoutCredential(command: AdapterCommand): AdapterCommand {
  const context = { ...command.context };
  delete context.credential;
  return {
    ...command,
    context,
  } as AdapterCommand;
}

export function createAdapterConformanceCases(
  fixture: AdapterConformanceFixture,
): readonly AdapterConformanceCase[] {
  const cases: AdapterConformanceCase[] = [
    {
      name: "capability document is complete and honest",
      async run() {
        const issues = validateCapabilityDocument(
          fixture.adapter.capabilityDocument,
        );
        ensure(issues.length === 0, issues.join(" "));
        for (const operation of supportedOperations(fixture)) {
          ensure(
            fixture.commands[operation] !== undefined,
            `Supported capability ${operation} is missing its mandatory probe.`,
          );
        }
      },
    },
    {
      name: "every supported operation returns its typed result",
      async run() {
        for (const operation of supportedOperations(fixture)) {
          const factory = fixture.commands[operation];
          ensure(factory !== undefined, `${operation} has no command probe.`);
          await resetFixture(fixture);
          const result = await fixture.adapter.execute(factory());
          const issues = validateOperationResult(operation, result);
          ensure(issues.length === 0, issues.join(" "));
        }
      },
    },
    {
      name: "unsupported operations return before side effects",
      async run() {
        const unsupported = unsupportedOperations(fixture);
        if (unsupported.length === 0) {
          return;
        }
        const operation = unsupported.find(
          (candidate) => fixture.commands[candidate] !== undefined,
        );
        ensure(
          operation !== undefined,
          "At least one unsupported operation requires a mandatory probe.",
        );
        const factory = fixture.commands[operation];
        ensure(factory !== undefined, "The unsupported probe is unavailable.");
        await resetFixture(fixture);
        const before = await fixture.sideEffects?.read();
        const result = await fixture.adapter.execute(factory());
        const after = await fixture.sideEffects?.read();
        ensure(
          result.status === "unsupported" && result.sideEffects === "none",
          `${operation} did not return explicit unsupported.`,
        );
        if (before !== undefined && after !== undefined) {
          ensure(
            before === after,
            `${operation} performed a side effect before returning unsupported.`,
          );
        }
      },
    },
    {
      name: "side-effecting calls require authenticated credentials",
      async run() {
        const operation = supportedSideEffects(fixture)[0];
        if (operation === undefined) {
          return;
        }
        ensure(
          fixture.sideEffects !== undefined,
          "Side-effect certification requires a side-effect probe.",
        );
        const factory = fixture.commands[operation];
        ensure(factory !== undefined, `${operation} has no command probe.`);
        await resetFixture(fixture);
        const before = await fixture.sideEffects.read();
        const result = await fixture.adapter.execute(
          withoutCredential(factory()),
        );
        const after = await fixture.sideEffects.read();
        ensure(
          result.status === "failure" &&
            (result.error.code === "authentication_required" ||
              result.error.code.startsWith("auth.")),
          "A side-effecting command accepted missing authentication.",
        );
        ensure(
          before === after,
          "An unauthenticated command performed a side effect.",
        );
      },
    },
    {
      name: "durable idempotency suppresses duplicate side effects",
      async run() {
        if (supportedSideEffects(fixture).length === 0) {
          return;
        }
        ensure(
          fixture.idempotency !== undefined &&
            fixture.sideEffects !== undefined,
          "Side-effect certification requires durable idempotency and side-effect probes.",
        );
        await resetFixture(fixture);
        const command = fixture.idempotency.command();
        const before = await fixture.sideEffects.read();
        const first = await fixture.adapter.execute(command);
        const restarted = await fixture.idempotency.restart();
        ensure(
          restarted !== fixture.adapter,
          "The restart probe must create a distinct adapter instance.",
        );
        const second = await restarted.execute(
          fixture.idempotency.retryCommand(),
        );
        const after = await fixture.sideEffects.read();
        ensure(
          first.status !== "failure" &&
            first.status !== "unsupported" &&
            stableValue(first) === stableValue(second),
          "Idempotent replay did not return the durable result.",
        );
        ensure(
          after - before === 1,
          "Idempotent replay dispatched more or fewer than one side effect.",
        );
      },
    },
    {
      name: "deadlines cancel real in-flight side effects",
      async run() {
        if (supportedSideEffects(fixture).length === 0) {
          return;
        }
        ensure(
          fixture.deadline !== undefined,
          "Side-effect certification requires a deadline cancellation probe.",
        );
        await resetFixture(fixture);
        const result = await fixture.adapter.execute(
          fixture.deadline.command(),
        );
        ensure(
          await fixture.deadline.wasCancelled(),
          "The in-flight side effect did not observe cancellation.",
        );
        ensure(
          result.status === "unknown" ||
            (result.status === "failure" &&
              result.error.code === "deadline_exceeded"),
          "The deadline did not produce an explicit ambiguous/expired result.",
        );
      },
    },
    {
      name: "send_test timeout is non-retryable across restart",
      async run() {
        if (!supportedOperations(fixture).includes("send_test")) {
          return;
        }
        ensure(
          fixture.sendTestTimeout !== undefined &&
            fixture.sideEffects !== undefined,
          "send_test certification requires timeout, restart, and side-effect probes.",
        );
        await resetFixture(fixture);
        const command = fixture.sendTestTimeout.command();
        const before = await fixture.sideEffects.read();
        const first = await fixture.adapter.execute(command);
        ensure(
          first.status === "unknown" && first.retryable === false,
          "A timed-out send_test must be unknown and non-retryable.",
        );
        const restarted = await fixture.sendTestTimeout.restart();
        ensure(
          restarted !== fixture.adapter,
          "The send_test restart probe must create a distinct adapter instance.",
        );
        const second = await restarted.execute(
          fixture.sendTestTimeout.retryCommand(),
        );
        const after = await fixture.sideEffects.read();
        ensure(
          second.status === "unknown" &&
            second.retryable === false &&
            stableValue(first) === stableValue(second),
          "Restart did not replay the durable send_test timeout result.",
        );
        ensure(
          after - before === 1,
          "send_test dispatched more than once across timeout and restart.",
        );
      },
    },
    {
      name: "cryptographic receivers reject forged and replayed inputs",
      async run() {
        ensure(
          fixture.security !== undefined,
          "Certification requires command, acknowledgement, and metadata ingest security probes.",
        );
        const command = await fixture.security.commandAuthentication();
        ensure(
          command.receiverVerified &&
            command.duplicateRejected &&
            command.conflictingReplayRejected &&
            command.concurrentConsumeSafe &&
            command.storedResultReplayed &&
            command.forgedRejected &&
            command.expiredRejected &&
            command.wrongScopeRejected,
          "Receiver-side command authentication probes did not all pass.",
        );
        const acknowledgement =
          await fixture.security.acknowledgementAuthentication();
        ensure(
          acknowledgement.signedVerified &&
            acknowledgement.forgedRejected &&
            acknowledgement.modifiedRejected &&
            acknowledgement.expiredRejected &&
            acknowledgement.replayedRejected &&
            acknowledgement.wrongKeyRejected &&
            acknowledgement.wrongScopeRejected &&
            acknowledgement.unsignedRejected,
          "Signed acknowledgement authentication probes did not all pass.",
        );
        const metadata = await fixture.security.metadataIngest();
        ensure(
          metadata.signedVerified &&
            metadata.forgedRejected &&
            metadata.wrongScopeRejected &&
            metadata.identityDerived,
          "The real metadata ingest security probes did not all pass.",
        );
      },
    },
    {
      name: "secret wrappers redact every inspection surface",
      async run() {
        for (const { secret, plaintext } of secretCases(fixture)) {
          for (const surface of [
            String(secret),
            JSON.stringify(secret),
            inspect(secret),
            JSON.stringify(redactSecrets({ secret, authorization: plaintext })),
          ]) {
            ensure(
              !surface.includes(plaintext) && surface.includes(REDACTED_SECRET),
              "A secret inspection surface leaked or failed to redact.",
            );
          }
        }
      },
    },
    {
      name: "metadata schema, dedupe, and reduction are identity scoped",
      async run() {
        const record = fixture.metadata ?? defaultMetadata();
        ensure(
          validateCanonicalMetadataRecord(record).ok,
          "The canonical metadata fixture is invalid.",
        );
        for (const forbidden of [
          { ...record, body: { payload: true } },
          { ...record, authorization: "secret" },
          { ...record, connectionId: "forged" },
          {
            ...record,
            eventVersion: {
              ...record.eventVersion,
              responseBody: "forbidden",
            },
          },
        ]) {
          ensure(
            !validateCanonicalMetadataRecord(forbidden).ok,
            "The closed metadata schema accepted forbidden data.",
          );
        }
        const first = reduceDeliveryAttempt(undefined, record);
        ensure(
          reduceDeliveryAttempt(first, record) === first,
          "Duplicate metadata changed reducer state.",
        );
        const delivered = deriveMetadata(record, {
          attempt: record.attempt,
          sequence: record.sequence,
          status: "delivered",
          responseStatusCode: 200,
          occurredAt: new Date(Date.parse(record.occurredAt) + 1).toISOString(),
        });
        const deliveredState = reduceDeliveryAttempt(first, delivered);
        ensure(
          deliveredState.current.status === "delivered",
          "A same-sequence terminal observation did not advance monotonically.",
        );
        ensure(
          reduceDeliveryAttempt(deliveredState, delivered) === deliveredState,
          "An exact terminal observation did not deduplicate.",
        );
        const oldAttempt = deriveMetadata(record, {
          attempt: record.attempt,
          sequence: Math.max(0, record.sequence - 1),
          status: "pending",
        });
        const reduced = reduceDeliveryAttempt(first, oldAttempt);
        ensure(
          reduced.current.attempt === record.attempt,
          "Out-of-order metadata regressed the current attempt.",
        );
        const otherConnection = deriveMetadata(
          record,
          {},
          { connectionId: "other-connection" },
        );
        let rejected = false;
        try {
          reduceDeliveryAttempt(first, otherConnection);
        } catch {
          rejected = true;
        }
        ensure(
          rejected,
          "The reducer combined metadata from different connections.",
        );
      },
    },
  ];
  return Object.freeze(cases.map((entry) => Object.freeze(entry)));
}

function safeFailureMessage(
  error: unknown,
  secrets: readonly SecretConformanceProbe[],
): string {
  let message =
    error instanceof Error ? error.message : "The conformance case failed.";
  for (const { plaintext } of secrets) {
    message = message.split(plaintext).join(REDACTED_SECRET);
  }
  return message;
}

async function executeCase(
  testCase: AdapterConformanceCase,
  fixture: AdapterConformanceFixture,
): Promise<ConformanceCaseResult> {
  const started = Date.now();
  try {
    await testCase.run();
    return Object.freeze({
      name: testCase.name,
      status: "passed",
      durationMilliseconds: Date.now() - started,
    });
  } catch (error: unknown) {
    return Object.freeze({
      name: testCase.name,
      status: "failed",
      message: safeFailureMessage(error, secretCases(fixture)),
      durationMilliseconds: Date.now() - started,
    });
  }
}

export async function runAdapterConformance(
  fixture: AdapterConformanceFixture,
): Promise<AdapterConformanceReport> {
  const results: ConformanceCaseResult[] = [];
  for (const testCase of createAdapterConformanceCases(fixture)) {
    results.push(await executeCase(testCase, fixture));
  }
  const failed = results.filter((entry) => entry.status === "failed").length;
  return Object.freeze({
    name: fixture.name ?? fixture.adapter.capabilityDocument.adapter.name,
    passed: failed === 0,
    failed,
    skipped: 0,
    succeeded: results.length - failed,
    results: Object.freeze(results),
  });
}

export function assertAdapterConformance(
  report: AdapterConformanceReport,
): void {
  if (!report.passed) {
    throw new AdapterConformanceError(
      report.results
        .filter((entry) => entry.status === "failed")
        .map((entry) => `${entry.name}: ${entry.message ?? "failed"}`)
        .join("; "),
    );
  }
}

export function registerAdapterConformanceTests(
  runner: ConformanceTestRunner,
  fixture: AdapterConformanceFixture,
): void {
  runner.describe(
    `${fixture.name ?? fixture.adapter.capabilityDocument.adapter.name} adapter conformance`,
    () => {
      for (const testCase of createAdapterConformanceCases(fixture)) {
        runner.test(testCase.name, async () => {
          const result = await executeCase(testCase, fixture);
          if (result.status === "failed") {
            throw new AdapterConformanceError(
              result.message ?? "The conformance case failed.",
            );
          }
        });
      }
    },
  );
}

export const defineAdapterConformanceTests = registerAdapterConformanceTests;
