// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CANONICAL_METADATA_SCHEMA_VERSION,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  SecretValue,
  createAdapterContext,
  canonicalizeMetadataRecord,
  createCapabilityDocument,
  createDeadlineSignal,
  deadlineAfter,
  degradedResult,
  failureResult,
  okResult,
  unknownResult,
  unsupportedResult,
  type AdapterCommand,
  type AdapterCommandResult,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

import {
  assertAdapterConformance,
  registerAdapterConformanceTests,
  runAdapterConformance,
  validateCapabilityDocument,
  validateOperationResult,
  type AdapterConformanceFixture,
  type ConformanceAdapter,
} from "../src/index.js";

function scopedCredential(): ScopedCredential {
  return {
    id: "credential-1",
    kind: "bearer",
    role: "command",
    secret: new SecretValue("conformance-secret"),
    scope: {
      adapterId: "conformance-fixture",
      connectionId: "connection-1",
      tenantId: "tenant-1",
      environments: ["test"],
      operations: ["endpoint.create"],
    },
  };
}

function command(key: string, timeoutMilliseconds = 5_000): AdapterCommand {
  return {
    kind: "endpoint.create",
    context: createAdapterContext({
      tenant: { id: "tenant-1" },
      environment: { id: "test" },
      connection: { id: "connection-1" },
      actor: { id: "actor-1", type: "service" },
      idempotency: { key },
      credential: scopedCredential(),
      deadline: deadlineAfter(timeoutMilliseconds),
    }),
    input: {
      endpoint: {
        id: "endpoint-1",
        url: "https://receiver.example/webhooks",
      },
    },
  };
}

function sendCommand(key: string, timeoutMilliseconds = 5_000): AdapterCommand {
  return {
    kind: "send_test",
    context: createAdapterContext({
      tenant: { id: "tenant-1" },
      environment: { id: "test" },
      connection: { id: "connection-1" },
      actor: { id: "actor-1", type: "service" },
      idempotency: { key },
      credential: {
        ...scopedCredential(),
        scope: {
          ...scopedCredential().scope,
          operations: ["endpoint.create", "send_test"],
        },
      },
      deadline: deadlineAfter(timeoutMilliseconds),
    }),
    input: {
      endpoint: { id: "endpoint-1" },
      eventType: "invoice.paid",
    },
  };
}

interface MutableCapability extends Record<string, unknown> {
  constraints?: unknown;
  idempotency?: unknown;
  operation?: unknown;
  reason?: unknown;
  sideEffecting?: unknown;
  status?: unknown;
}

interface MutableCapabilityDocument extends Record<string, unknown> {
  adapter: Record<string, unknown>;
  capabilities: Record<string, MutableCapability>;
  operations: MutableCapability[];
}

function mutableCapabilityDocument(): MutableCapabilityDocument {
  return JSON.parse(
    JSON.stringify(fixture().adapter.capabilityDocument),
  ) as MutableCapabilityDocument;
}

function fixture(): AdapterConformanceFixture {
  let effects = 0;
  let cancelled = false;
  let counter = 0;
  const durable = new Map<string, AdapterCommandResult>();
  const capabilityDocument = createCapabilityDocument({
    adapter: {
      id: "conformance-fixture",
      name: "Conformance fixture",
      version: "1.0.0",
    },
    capabilities: {
      "endpoint.create": "supported",
      send_test: "supported",
    },
  });
  const makeAdapter = (): ConformanceAdapter => ({
    capabilityDocument,
    async execute(candidate) {
      if (candidate.kind === "endpoint.delete") {
        return unsupportedResult(candidate.kind);
      }
      if (
        candidate.kind !== "endpoint.create" &&
        candidate.kind !== "send_test"
      ) {
        return failureResult({
          code: "unexpected_operation",
          message: "Unexpected operation.",
          retryable: false,
        });
      }
      if (candidate.context.credential === undefined) {
        return failureResult({
          code: "authentication_required",
          message: "Credential required.",
          retryable: false,
        });
      }
      const prior = durable.get(candidate.context.idempotency.key);
      if (prior !== undefined) {
        return prior;
      }
      effects += 1;
      if (candidate.kind === "send_test") {
        const result = candidate.context.idempotency.key.startsWith(
          "send-timeout-",
        )
          ? (unknownResult("send timeout", undefined, {
              retryable: false,
            }) as AdapterCommandResult)
          : (okResult(
              {
                accepted: true,
                state: "accepted" as const,
                deliveryId: "delivery-1",
              },
              { sideEffects: "confirmed" },
            ) as AdapterCommandResult);
        durable.set(candidate.context.idempotency.key, result);
        return result;
      }
      if (candidate.context.idempotency.key.startsWith("deadline-")) {
        const deadline = createDeadlineSignal(
          candidate.context.deadline,
          candidate.context.signal,
        );
        await new Promise<void>((resolve) => {
          const abort = (): void => {
            cancelled = true;
            resolve();
          };
          if (deadline.signal.aborted) {
            abort();
          } else {
            deadline.signal.addEventListener("abort", abort, { once: true });
          }
        });
        const result = unknownResult("deadline") as AdapterCommandResult;
        durable.set(candidate.context.idempotency.key, result);
        return result;
      }
      const result = okResult(
        {
          endpoint: {
            id: "endpoint-1",
            state: "active" as const,
            mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
          },
        },
        { sideEffects: "confirmed" },
      ) as AdapterCommandResult;
      durable.set(candidate.context.idempotency.key, result);
      return result;
    },
  });
  const adapter = makeAdapter();

  return {
    name: "Harness self-test",
    adapter,
    commands: {
      "endpoint.create": () => command(`success-${counter++}`),
      "endpoint.delete": () => ({
        ...command(`unsupported-${counter++}`),
        kind: "endpoint.delete",
        input: { endpoint: { id: "endpoint-1" } },
      }),
      send_test: () => sendCommand(`send-success-${counter++}`),
    },
    sideEffects: {
      read: () => effects,
      reset: () => {
        effects = 0;
      },
    },
    reset: () => {
      cancelled = false;
    },
    idempotency: {
      command: () => command("idempotency-fixed"),
      retryCommand: () => command("idempotency-fixed"),
      restart: () => makeAdapter(),
    },
    deadline: {
      command: () => command(`deadline-${counter++}`, 10),
      wasCancelled: () => cancelled,
    },
    sendTestTimeout: {
      command: () => sendCommand("send-timeout-fixed", 10),
      retryCommand: () => sendCommand("send-timeout-fixed", 5_000),
      restart: () => makeAdapter(),
    },
    security: {
      async commandAuthentication() {
        return {
          receiverVerified: true,
          duplicateRejected: true,
          conflictingReplayRejected: true,
          concurrentConsumeSafe: true,
          storedResultReplayed: true,
          forgedRejected: true,
          expiredRejected: true,
          wrongScopeRejected: true,
        };
      },
      async acknowledgementAuthentication() {
        return {
          signedVerified: true,
          forgedRejected: true,
          modifiedRejected: true,
          expiredRejected: true,
          replayedRejected: true,
          wrongKeyRejected: true,
          wrongScopeRejected: true,
          unsignedRejected: true,
        };
      },
      async metadataIngest() {
        return {
          signedVerified: true,
          forgedRejected: true,
          wrongScopeRejected: true,
          identityDerived: true,
        };
      },
    },
  };
}

describe("adapter conformance harness", () => {
  it("passes only with all mandatory security and correctness probes", async () => {
    const report = await runAdapterConformance(fixture());
    expect(report.passed).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.succeeded).toBe(10);
    expect(() => assertAdapterConformance(report)).not.toThrow();
  });

  it("fails certification when a mandatory idempotency probe is absent", async () => {
    const complete = fixture();
    const incomplete = { ...complete };
    delete incomplete.idempotency;
    const report = await runAdapterConformance(incomplete);
    expect(report.passed).toBe(false);
    expect(
      report.results.some(
        (entry) =>
          entry.status === "failed" &&
          entry.message?.includes("durable idempotency"),
      ),
    ).toBe(true);
  });

  it("rejects an always-failing adapter advertising support", async () => {
    const base = fixture();
    const dishonest: AdapterConformanceFixture = {
      ...base,
      adapter: {
        capabilityDocument: base.adapter.capabilityDocument,
        async execute() {
          return failureResult({
            code: "always_fails",
            message: "No operation can succeed.",
            retryable: false,
          });
        },
      },
    };
    const report = await runAdapterConformance(dishonest);
    expect(report.passed).toBe(false);
    expect(() => assertAdapterConformance(report)).toThrow(
      /returned failure/iu,
    );
  });

  it("fails certification when cryptographic receiver probes are absent", async () => {
    const incomplete = { ...fixture() };
    delete incomplete.security;
    const report = await runAdapterConformance(incomplete);
    expect(report.passed).toBe(false);
    expect(
      report.results.some(
        (entry) =>
          entry.status === "failed" &&
          entry.message?.includes("security probes"),
      ),
    ).toBe(true);
  });

  it("accepts JSON round-tripped SDK documents and detects real divergence", () => {
    const document = createCapabilityDocument({
      adapter: {
        id: "conformance-fixture",
        name: "Conformance fixture",
        version: "1.0.0",
        homepage: "https://adapter.example",
        vendor: "Example vendor",
      },
      generatedAt: "2026-07-17T00:00:00.000Z",
      capabilities: {
        "endpoint.create": {
          status: "supported",
          reason: "Available in every region.",
          constraints: {
            enabled: true,
            maximumBatchSize: 100,
            modes: ["synchronous", "asynchronous"],
          },
        },
      },
    });
    const roundTripped = JSON.parse(
      JSON.stringify(document),
    ) as typeof document;
    expect(validateCapabilityDocument(roundTripped)).toEqual([]);

    const divergent = JSON.parse(JSON.stringify(document)) as {
      capabilities: Record<string, { status: string }>;
    } & typeof document;
    const endpointCreate = divergent.capabilities["endpoint.create"];
    if (endpointCreate === undefined) {
      throw new Error("Missing endpoint.create capability.");
    }
    (endpointCreate as unknown as { status: string }).status = "unsupported";
    expect(validateCapabilityDocument(divergent)).toContain(
      "endpoint.create differs between indexes.",
    );
  });

  it.each([
    {
      name: "non-object document",
      expected: "must be an object",
      make: () => null,
    },
    {
      name: "wrong kind",
      expected: "kind is invalid",
      make: () => {
        const document = mutableCapabilityDocument();
        document["kind"] = "wrong";
        return document;
      },
    },
    {
      name: "empty adapter identity",
      expected: "adapter.id",
      make: () => {
        const document = mutableCapabilityDocument();
        document.adapter["id"] = "";
        return document;
      },
    },
    {
      name: "bogus capability status",
      expected: "status is invalid",
      make: () => {
        const document = mutableCapabilityDocument();
        const capability = document.operations[0] as MutableCapability;
        capability.status = "bogus";
        return document;
      },
    },
    {
      name: "unknown top-level field",
      expected: "unknown field surprise",
      make: () => {
        const document = mutableCapabilityDocument();
        document["surprise"] = true;
        return document;
      },
    },
    {
      name: "missing operations field",
      expected: "missing required field operations",
      make: () => {
        const document = mutableCapabilityDocument();
        delete document["operations"];
        return document;
      },
    },
    {
      name: "non-array operations",
      expected: "operations must be an array",
      make: () => {
        const document = mutableCapabilityDocument();
        document["operations"] = {};
        return document;
      },
    },
    {
      name: "duplicate operation",
      expected: "declared more than once",
      make: () => {
        const document = mutableCapabilityDocument();
        document.operations[1] = {
          ...(document.operations[0] as MutableCapability),
        };
        return document;
      },
    },
    {
      name: "unknown capability field",
      expected: "unknown field extra",
      make: () => {
        const document = mutableCapabilityDocument();
        const capability = document.operations[0] as MutableCapability;
        capability["extra"] = true;
        return document;
      },
    },
    {
      name: "non-boolean side-effect flag",
      expected: "sideEffecting must be boolean",
      make: () => {
        const document = mutableCapabilityDocument();
        const capability = document.operations[0] as MutableCapability;
        capability.sideEffecting = "yes";
        return document;
      },
    },
    {
      name: "bogus idempotency status",
      expected: "idempotency is invalid",
      make: () => {
        const document = mutableCapabilityDocument();
        const capability = document.operations[0] as MutableCapability;
        capability.idempotency = "sometimes";
        return document;
      },
    },
    {
      name: "unbounded reason",
      expected: "reason must be a bounded safe string",
      make: () => {
        const document = mutableCapabilityDocument();
        const capability = document.operations[0] as MutableCapability;
        capability.reason = "x".repeat(2_049);
        return document;
      },
    },
    {
      name: "nested constraint value",
      expected: "bounded JSON constraint scalar",
      make: () => {
        const document = mutableCapabilityDocument();
        const capability = document.operations[0] as MutableCapability;
        capability.constraints = { nested: { invalid: true } };
        return document;
      },
    },
    {
      name: "mixed constraint array",
      expected: "must contain one scalar type",
      make: () => {
        const document = mutableCapabilityDocument();
        const capability = document.operations[0] as MutableCapability;
        capability.constraints = { mixed: ["one", 2] };
        return document;
      },
    },
    {
      name: "sparse operation array",
      expected: "must be an enumerable data property",
      make: () => {
        const document = mutableCapabilityDocument();
        delete document.operations[0];
        return document;
      },
    },
    {
      name: "accessor identity field",
      expected: "must be an enumerable data property",
      make: () => {
        const document = mutableCapabilityDocument();
        Object.defineProperty(document.adapter, "name", {
          enumerable: true,
          get() {
            throw new Error("The validator must not invoke accessors.");
          },
        });
        return document;
      },
    },
    {
      name: "revoked proxy",
      expected: "could not be safely inspected",
      make: () => {
        const proxy = Proxy.revocable({}, {});
        proxy.revoke();
        return proxy.proxy;
      },
    },
  ])(
    "rejects malformed/fuzzed capability document: $name",
    ({ expected, make }) => {
      let issues: readonly string[] = [];
      expect(() => {
        issues = validateCapabilityDocument(make());
      }).not.toThrow();
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.join(" ")).toContain(expected);
    },
  );

  it("never treats an invalid capability status as supported", async () => {
    const base = fixture();
    const malformed = mutableCapabilityDocument();
    const listed = malformed.operations.find(
      (capability) => capability.operation === "endpoint.create",
    );
    const indexed = malformed.capabilities["endpoint.create"];
    if (listed === undefined || indexed === undefined) {
      throw new Error("Missing endpoint.create capability.");
    }
    listed.status = "bogus";
    indexed.status = "bogus";
    let endpointCreateCalls = 0;
    const report = await runAdapterConformance({
      ...base,
      adapter: {
        capabilityDocument:
          malformed as unknown as typeof base.adapter.capabilityDocument,
        async execute(candidate) {
          if (candidate.kind === "endpoint.create") {
            endpointCreateCalls += 1;
          }
          return base.adapter.execute(candidate);
        },
      },
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]?.message).toContain("status is invalid");
    expect(endpointCreateCalls).toBe(0);
  });

  it("requires side-effect-free result metadata for read operations in every state", () => {
    const endpointValue = {
      endpoint: {
        id: "endpoint-1",
        state: "active" as const,
        mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
      },
    };
    const validReadResults: AdapterCommandResult[] = [
      okResult(endpointValue, { sideEffects: "none" }),
      degradedResult("pending", {
        value: endpointValue,
        sideEffects: "none",
      }) as AdapterCommandResult,
      failureResult(
        {
          code: "not_found",
          message: "not found",
          retryable: false,
        },
        { sideEffects: "none" },
      ),
      unknownResult("read timed out", undefined, {
        sideEffects: "none",
      }),
    ];
    for (const result of validReadResults) {
      expect(validateOperationResult("endpoint.read", result)).not.toContain(
        "endpoint.read incorrectly reported side effects.",
      );
    }
    expect(
      validateOperationResult(
        "endpoint.read",
        unknownResult("invalid read outcome", undefined, {
          sideEffects: "possible",
        }),
      ),
    ).toContain("endpoint.read incorrectly reported side effects.");
  });

  it("derives metadata follow-ups from a custom fixture identity", async () => {
    const customMetadata = canonicalizeMetadataRecord(
      {
        kind: "delivery_attempt",
        schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
        eventId: "custom-event",
        deliveryId: "custom-delivery",
        endpointId: "custom-endpoint",
        eventVersion: {
          eventType: "custom.event",
          version: "v9",
          schemaChecksum: "b".repeat(64),
        },
        attempt: 4,
        sequence: 8,
        status: "attempting",
        occurredAt: "2026-07-16T12:00:00.000Z",
        mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
      },
      {
        tenantId: "custom-tenant",
        environment: "custom-environment",
        connectionId: "custom-connection",
        adapterId: "custom-adapter",
      },
    );
    const report = await runAdapterConformance({
      ...fixture(),
      metadata: customMetadata,
    });
    expect(report.passed, JSON.stringify(report.results)).toBe(true);
  });

  it("registers all cases with a Vitest-compatible structural runner", () => {
    const names: string[] = [];
    registerAdapterConformanceTests(
      {
        describe(_name, body) {
          body();
        },
        test(name) {
          names.push(name);
        },
      },
      fixture(),
    );
    expect(names).toHaveLength(10);
    expect(names).toContain(
      "side-effecting calls require authenticated credentials",
    );
  });
});
