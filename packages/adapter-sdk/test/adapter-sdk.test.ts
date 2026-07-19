// SPDX-License-Identifier: Apache-2.0

import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADAPTER_OPERATIONS,
  AdapterDeadlineError,
  CANONICAL_METADATA_SCHEMA_VERSION,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  InMemoryCommandEnvelopeReplayStore,
  MAX_COMMAND_REPLAY_RETENTION_MILLISECONDS,
  REDACTED_SECRET,
  SecretValue,
  canonicalizeMetadataRecord,
  checkCredentialScope,
  commandReplayIdentityStorageKey,
  commandReplayNonceStorageKey,
  createAdapterContext,
  createAuthenticatedCommandEnvelope,
  createAuthenticatedMetadataIngestEnvelope,
  createCapabilityDocument,
  createDeadlineSignal,
  completeCommandEnvelopeReplay,
  deadlineAfter,
  deliveryAttemptDedupeKey,
  computeAdapterCommandFingerprint,
  isWellFormedUnicode,
  isProviderNativeRef,
  okResult,
  hasSameSecretMaterial,
  redactSecrets,
  reduceDeliveryAttempt,
  unknownResult,
  withDeadline,
  validateCanonicalMetadataRecord,
  validateMetadataDeliveryAttemptInput,
  verifyAuthenticatedCommandEnvelope,
  verifyAuthenticatedCommandEnvelopeWithReplay,
  verifyAuthenticatedMetadataIngestEnvelope,
  type AdapterCommandResult,
  type CommandEnvelopeReplayStore,
  type EndpointCreateCommand,
  type MetadataDeliveryAttemptInput,
  type ScopedCredential,
} from "../src/index.js";

const now = 1_800_000_000_000;

function credential(
  operations: NonNullable<ScopedCredential["scope"]["operations"]>,
): ScopedCredential {
  return {
    id: "credential-1",
    kind: "bearer",
    role: operations.includes("metadata.ingest")
      ? "metadata_ingest"
      : "command",
    secret: new SecretValue("credential-secret-9b1"),
    scope: {
      adapterId: "adapter-1",
      connectionId: "connection-1",
      tenantId: "tenant-1",
      environments: ["production"],
      operations,
      ...(operations?.includes("metadata.ingest")
        ? {}
        : { hosts: ["api.example.com"] }),
      expiresAt: now + 60_000,
    },
  };
}

function endpointCommand(
  scopedCredential = credential(["endpoint.create"]),
): EndpointCreateCommand {
  return {
    kind: "endpoint.create",
    context: createAdapterContext({
      tenant: { id: "tenant-1" },
      environment: { id: "production" },
      connection: { id: "connection-1" },
      actor: { id: "actor-1", type: "service" },
      idempotency: { key: "idempotency-1" },
      credential: scopedCredential,
      deadline: now + 30_000,
    }),
    input: {
      endpoint: {
        id: "endpoint-1",
        url: "https://receiver.example/webhooks",
      },
    },
  };
}

function metadataInput(
  overrides: Partial<MetadataDeliveryAttemptInput> = {},
): MetadataDeliveryAttemptInput {
  return {
    kind: "delivery_attempt",
    schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
    eventId: "event-1",
    deliveryId: "delivery-1",
    endpointId: "endpoint-1",
    eventVersion: {
      eventType: "invoice.paid",
      version: "2026-07-01",
      schemaChecksum: "a".repeat(64),
    },
    attempt: 1,
    sequence: 1,
    status: "attempting",
    occurredAt: "2026-07-01T00:00:00.000Z",
    mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("frozen adapter operation contract", () => {
  it("uses the exact overlap name and separates inbound metadata ingestion", () => {
    expect(ADAPTER_OPERATIONS).toContain("secret.rotate_with_overlap");
    expect(ADAPTER_OPERATIONS).not.toContain("secret.rotate-overlap");
    expect(ADAPTER_OPERATIONS).not.toContain("metadata.push");

    const document = createCapabilityDocument({
      adapter: { id: "adapter", name: "Adapter", version: "1" },
      capabilities: { "secret.rotate_with_overlap": "supported" },
    });
    expect(document.operations).toHaveLength(ADAPTER_OPERATIONS.length);
    expect(
      document.capabilities["secret.rotate_with_overlap"].sideEffecting,
    ).toBe(true);
  });
});

describe("authenticated command envelope", () => {
  it("binds operation, payload, identity, connection, deadline, key, and fingerprint", () => {
    const scopedCredential = credential(["endpoint.create"]);
    const envelope = createAuthenticatedCommandEnvelope(
      endpointCommand(scopedCredential),
      scopedCredential,
      { issuedAt: now },
    );
    const result = verifyAuthenticatedCommandEnvelope(
      envelope,
      scopedCredential,
      {
        adapterId: "adapter-1",
        tenantId: "tenant-1",
        environment: "production",
        connectionId: "connection-1",
        operation: "endpoint.create",
        actor: { id: "actor-1", type: "service" },
        host: "api.example.com",
      },
      { now },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "envelope.replay_protection_required",
    });
    expect(envelope).toMatchObject({
      operation: "endpoint.create",
      command: {
        kind: "endpoint.create",
        input: { endpoint: { id: "endpoint-1" } },
      },
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      actor: { id: "actor-1", type: "service" },
      idempotencyKey: "idempotency-1",
      issuedAt: now,
      deadlineAt: now + 30_000,
    });
    expect(envelope.commandFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      createAuthenticatedCommandEnvelope(
        endpointCommand(scopedCredential),
        { ...scopedCredential, id: "other-credential" },
        { issuedAt: now },
      ),
    ).toThrow(/does not match/iu);
  });

  it("atomically rejects duplicates, replays results, and detects conflicts", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const command = endpointCommand(scopedCredential);
    const envelope = createAuthenticatedCommandEnvelope(
      command,
      scopedCredential,
      { issuedAt: now, nonce: "receiver-nonce-1" },
    );
    const expected = {
      adapterId: "adapter-1",
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      operation: "endpoint.create" as const,
      actor: { id: "actor-1", type: "service" as const },
      host: "api.example.com",
    };
    const store = new InMemoryCommandEnvelopeReplayStore({
      clock: () => now,
      tokenFactory: () => "receiver-lease-1",
    });

    const accepted = await verifyAuthenticatedCommandEnvelopeWithReplay(
      envelope,
      scopedCredential,
      expected,
      store,
      {
        now,
        storeDeadlineAt: now + 1_000,
        replayRetentionMilliseconds: 60_000,
      },
    );
    expect(accepted).toMatchObject({
      ok: true,
      status: "accepted",
      lease: { leaseToken: "receiver-lease-1" },
    });
    expect(
      await verifyAuthenticatedCommandEnvelopeWithReplay(
        envelope,
        scopedCredential,
        expected,
        store,
        {
          now,
          storeDeadlineAt: now + 1_000,
          replayRetentionMilliseconds: 60_000,
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "envelope.replay_in_progress",
    });
    if (!accepted.ok || accepted.status !== "accepted") {
      throw new Error("Expected an accepted replay-protected envelope.");
    }
    const storedResult = okResult(
      {
        endpoint: {
          id: "endpoint-1",
          state: "active" as const,
          mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
        },
      },
      { sideEffects: "confirmed" },
    ) as AdapterCommandResult;
    await completeCommandEnvelopeReplay(store, accepted, storedResult, {
      deadlineAt: now + 1_000,
    });
    expect(
      await verifyAuthenticatedCommandEnvelopeWithReplay(
        envelope,
        scopedCredential,
        expected,
        store,
        {
          now,
          storeDeadlineAt: now + 1_000,
          replayRetentionMilliseconds: 60_000,
        },
      ),
    ).toMatchObject({
      ok: true,
      status: "replay",
      result: storedResult,
    });

    const conflicting = createAuthenticatedCommandEnvelope(
      {
        ...command,
        input: {
          endpoint: {
            id: "different-endpoint",
            url: "https://receiver.example/webhooks",
          },
        },
      },
      scopedCredential,
      { issuedAt: now, nonce: "receiver-nonce-2" },
    );
    expect(
      await verifyAuthenticatedCommandEnvelopeWithReplay(
        conflicting,
        scopedCredential,
        expected,
        store,
        {
          now,
          storeDeadlineAt: now + 1_000,
          replayRetentionMilliseconds: 60_000,
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "envelope.replay_conflict",
    });
  });

  it("requires host context for host-scoped command credentials", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const envelope = createAuthenticatedCommandEnvelope(
      endpointCommand(scopedCredential),
      scopedCredential,
      { issuedAt: now, nonce: "host-scope-nonce" },
    );
    const baseExpected = {
      adapterId: "adapter-1",
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      operation: "endpoint.create" as const,
    };
    const store = new InMemoryCommandEnvelopeReplayStore({
      clock: () => now,
    });
    for (const expected of [
      baseExpected,
      { ...baseExpected, host: "wrong.example.com" },
    ]) {
      expect(
        await verifyAuthenticatedCommandEnvelopeWithReplay(
          envelope,
          scopedCredential,
          expected,
          store,
          {
            now,
            storeDeadlineAt: now + 1_000,
            replayRetentionMilliseconds: 60_000,
          },
        ),
      ).toMatchObject({
        ok: false,
        code: "envelope.host_scope_mismatch",
      });
    }
    expect(
      await verifyAuthenticatedCommandEnvelopeWithReplay(
        envelope,
        scopedCredential,
        { ...baseExpected, host: "API.EXAMPLE.COM." },
        store,
        {
          now,
          storeDeadlineAt: now + 1_000,
          replayRetentionMilliseconds: 60_000,
        },
      ),
    ).toMatchObject({ ok: true, status: "accepted" });
  });

  it("replays a newly signed equivalent envelope after the original deadline within retention", async () => {
    let storeClock = now;
    const scopedCredential = credential(["endpoint.create"]);
    const originalCommand = endpointCommand(scopedCredential);
    const original = createAuthenticatedCommandEnvelope(
      originalCommand,
      scopedCredential,
      { issuedAt: now, nonce: "retention-original" },
    );
    const expected = {
      adapterId: "adapter-1",
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      operation: "endpoint.create" as const,
      host: "api.example.com",
    };
    const store = new InMemoryCommandEnvelopeReplayStore({
      clock: () => storeClock,
    });
    const accepted = await verifyAuthenticatedCommandEnvelopeWithReplay(
      original,
      scopedCredential,
      expected,
      store,
      {
        now,
        storeDeadlineAt: now + 1_000,
        replayRetentionMilliseconds: 60_000,
      },
    );
    if (!accepted.ok || accepted.status !== "accepted") {
      throw new Error("Expected the original command to be accepted.");
    }
    const storedResult = okResult(
      {
        endpoint: {
          id: "endpoint-1",
          state: "active" as const,
          mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
        },
      },
      { sideEffects: "confirmed" },
    ) as AdapterCommandResult;
    await completeCommandEnvelopeReplay(store, accepted, storedResult, {
      deadlineAt: now + 1_000,
    });

    storeClock = original.deadlineAt + 1;
    const refreshedCommand: EndpointCreateCommand = {
      ...originalCommand,
      context: createAdapterContext({
        tenant: { id: "tenant-1" },
        environment: { id: "production" },
        connection: { id: "connection-1" },
        actor: { id: "actor-1", type: "service" },
        idempotency: { key: originalCommand.context.idempotency.key },
        credential: scopedCredential,
        deadline: storeClock + 20_000,
      }),
    };
    const refreshed = createAuthenticatedCommandEnvelope(
      refreshedCommand,
      scopedCredential,
      { issuedAt: storeClock, nonce: "retention-refreshed" },
    );
    expect(refreshed.commandFingerprint).toBe(original.commandFingerprint);
    expect(
      await verifyAuthenticatedCommandEnvelopeWithReplay(
        refreshed,
        scopedCredential,
        expected,
        store,
        {
          now: storeClock,
          storeDeadlineAt: storeClock + 1_000,
          replayRetentionMilliseconds: 60_000,
        },
      ),
    ).toMatchObject({
      ok: true,
      status: "replay",
      result: storedResult,
    });

    const conflicting = createAuthenticatedCommandEnvelope(
      {
        ...refreshedCommand,
        input: {
          endpoint: {
            id: "conflicting-endpoint",
            url: "https://receiver.example/webhooks",
          },
        },
      },
      scopedCredential,
      { issuedAt: storeClock, nonce: "retention-conflict" },
    );
    expect(
      await verifyAuthenticatedCommandEnvelopeWithReplay(
        conflicting,
        scopedCredential,
        expected,
        store,
        {
          now: storeClock,
          storeDeadlineAt: storeClock + 1_000,
          replayRetentionMilliseconds: 60_000,
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "envelope.replay_conflict",
    });
  });

  it("allows only one concurrent receiver consume and purges expired identities", async () => {
    let storeClock = now;
    let token = 0;
    const scopedCredential = credential(["endpoint.create"]);
    const envelope = createAuthenticatedCommandEnvelope(
      endpointCommand(scopedCredential),
      scopedCredential,
      { issuedAt: now, nonce: "concurrent-nonce" },
    );
    const store = new InMemoryCommandEnvelopeReplayStore({
      clock: () => storeClock,
      tokenFactory: () => `concurrent-lease-${++token}`,
    });
    const expected = {
      adapterId: "adapter-1",
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      operation: "endpoint.create" as const,
      host: "api.example.com",
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        verifyAuthenticatedCommandEnvelopeWithReplay(
          envelope,
          scopedCredential,
          expected,
          store,
          {
            now,
            storeDeadlineAt: now + 1_000,
            replayRetentionMilliseconds: 60_000,
          },
        ),
      ),
    );
    expect(
      results.filter((result) => result.ok && result.status === "accepted"),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.ok && result.code === "envelope.replay_in_progress",
      ),
    ).toHaveLength(3);
    storeClock = now + 59_999;
    expect(store.purgeExpired()).toBe(0);
    storeClock = now + 60_000;
    expect(store.purgeExpired()).toBe(1);
  });

  it("rejects replay retention outside the supported bounds", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const envelope = createAuthenticatedCommandEnvelope(
      endpointCommand(scopedCredential),
      scopedCredential,
      { issuedAt: now, nonce: "retention-bounds" },
    );
    const expected = {
      adapterId: "adapter-1",
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      operation: "endpoint.create" as const,
      host: "api.example.com",
    };
    for (const replayRetentionMilliseconds of [
      0,
      MAX_COMMAND_REPLAY_RETENTION_MILLISECONDS + 1,
    ]) {
      expect(
        await verifyAuthenticatedCommandEnvelopeWithReplay(
          envelope,
          scopedCredential,
          expected,
          new InMemoryCommandEnvelopeReplayStore(),
          {
            now,
            storeDeadlineAt: now + 1_000,
            replayRetentionMilliseconds,
          },
        ),
      ).toMatchObject({
        ok: false,
        code: "envelope.replay_retention_invalid",
      });
    }
  });

  it.each(["deadline", "abort"] as const)(
    "bounds receiver replay-store I/O by %s",
    async (mode) => {
      const current = Date.now();
      const scopedCredential = credential(["endpoint.create"]);
      const command: EndpointCreateCommand = {
        ...endpointCommand(scopedCredential),
        context: createAdapterContext({
          tenant: { id: "tenant-1" },
          environment: { id: "production" },
          connection: { id: "connection-1" },
          actor: { id: "actor-1", type: "service" },
          idempotency: { key: `hung-replay-${mode}` },
          credential: scopedCredential,
          deadline: current + 2_000,
        }),
      };
      const envelope = createAuthenticatedCommandEnvelope(
        command,
        scopedCredential,
        { issuedAt: current, nonce: `hung-replay-nonce-${mode}` },
      );
      let observedSignal: AbortSignal | undefined;
      const replayStore: CommandEnvelopeReplayStore = {
        consume(input) {
          observedSignal = input.signal;
          return new Promise<never>(() => {});
        },
        async complete() {},
      };
      const parent = new AbortController();
      const pending = verifyAuthenticatedCommandEnvelopeWithReplay(
        envelope,
        scopedCredential,
        {
          adapterId: "adapter-1",
          tenantId: "tenant-1",
          environment: "production",
          connectionId: "connection-1",
          operation: "endpoint.create",
          host: "api.example.com",
        },
        replayStore,
        {
          now: current,
          storeDeadlineAt:
            mode === "deadline" ? Date.now() + 500 : current + 1_000,
          replayRetentionMilliseconds: 60_000,
          signal: parent.signal,
        },
      );
      if (mode === "abort") {
        parent.abort(new Error("receiver cancelled"));
      }
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "envelope.replay_store_unavailable",
      });
      expect(observedSignal?.aborted).toBe(true);
    },
  );

  it("rejects forged, expired, wrong-audience, and fingerprint-mismatched envelopes", () => {
    const scopedCredential = credential(["endpoint.create"]);
    const envelope = createAuthenticatedCommandEnvelope(
      endpointCommand(scopedCredential),
      scopedCredential,
      { issuedAt: now },
    );
    const expected = {
      adapterId: "adapter-1",
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      operation: "endpoint.create" as const,
      host: "api.example.com",
    };
    const forged = {
      ...envelope,
      signature: { ...envelope.signature, value: "A".repeat(43) },
    };
    const mismatched = {
      ...envelope,
      command: {
        ...envelope.command,
        input: {
          endpoint: {
            id: "endpoint-forged",
            url: "https://receiver.example/webhooks",
          },
        },
      },
    };

    expect(
      verifyAuthenticatedCommandEnvelope(forged, scopedCredential, expected, {
        now,
      }),
    ).toMatchObject({ ok: false, code: "envelope.signature_invalid" });
    expect(
      verifyAuthenticatedCommandEnvelope(
        mismatched,
        scopedCredential,
        expected,
        { now },
      ),
    ).toMatchObject({ ok: false, code: "envelope.fingerprint_mismatch" });
    expect(
      verifyAuthenticatedCommandEnvelope(envelope, scopedCredential, expected, {
        now: now + 31_000,
      }),
    ).toMatchObject({ ok: false, code: "envelope.expired" });
    expect(
      verifyAuthenticatedCommandEnvelope(
        envelope,
        scopedCredential,
        { ...expected, tenantId: "other" },
        { now },
      ),
    ).toMatchObject({ ok: false, code: "envelope.wrong_tenant" });
    expect(
      verifyAuthenticatedCommandEnvelope(
        envelope,
        scopedCredential,
        { ...expected, environment: "staging" },
        { now },
      ),
    ).toMatchObject({ ok: false, code: "envelope.wrong_environment" });
    expect(
      verifyAuthenticatedCommandEnvelope(
        envelope,
        scopedCredential,
        { ...expected, connectionId: "other" },
        { now },
      ),
    ).toMatchObject({ ok: false, code: "envelope.wrong_connection" });
  });
});

describe("metadata authentication and canonicalization", () => {
  it("derives identity from the authenticated connection and rejects caller identity", () => {
    const scopedCredential = credential(["metadata.ingest"]);
    const identity = {
      tenantId: "tenant-1",
      environment: "production",
      adapterId: "adapter-1",
      connectionId: "connection-1",
    };
    const envelope = createAuthenticatedMetadataIngestEnvelope(
      [metadataInput()],
      identity,
      "batch-1",
      scopedCredential,
      { issuedAt: now, expiresAt: now + 30_000 },
    );
    const verified = verifyAuthenticatedMetadataIngestEnvelope(
      envelope,
      scopedCredential,
      identity,
      { now },
    );

    expect(verified.ok).toBe(true);
    if (!verified.ok) {
      throw new Error("Expected valid metadata ingest.");
    }
    expect(verified.records[0]).toMatchObject(identity);
    expect(verified.records[0]?.endpointId).toBe("endpoint-1");
    expect(
      validateMetadataDeliveryAttemptInput({
        ...metadataInput(),
        tenantId: "forged",
      }).ok,
    ).toBe(false);
    expect(
      validateMetadataDeliveryAttemptInput({
        ...metadataInput(),
        eventVersion: {
          ...metadataInput().eventVersion,
          body: "forbidden",
        },
      }).ok,
    ).toBe(false);
    for (const providerRef of [
      {
        provider: "provider",
        resourceType: "delivery",
        id: "native-1",
        accountId: { nested: "forbidden" },
      },
      {
        provider: "provider",
        resourceType: "delivery",
        id: "native-1",
        headers: { authorization: "secret" },
      },
      {
        provider: "provider",
        resourceType: "delivery",
        id: "native-1",
        authorization: "secret",
      },
      {
        provider: "provider",
        resourceType: "delivery",
        id: "native-1",
        body: "payload",
      },
      {
        provider: "provider",
        resourceType: "delivery",
        id: "native-1",
        region: "bad\u0000region",
      },
    ]) {
      expect(isProviderNativeRef(providerRef)).toBe(false);
      expect(
        validateMetadataDeliveryAttemptInput({
          ...metadataInput(),
          providerRef,
        }).ok,
      ).toBe(false);
    }
  });

  it("rejects forged metadata batches and wrong authenticated connections", () => {
    const scopedCredential = credential(["metadata.ingest"]);
    const identity = {
      tenantId: "tenant-1",
      environment: "production",
      adapterId: "adapter-1",
      connectionId: "connection-1",
    };
    const envelope = createAuthenticatedMetadataIngestEnvelope(
      [metadataInput()],
      identity,
      "batch-1",
      scopedCredential,
      { issuedAt: now, expiresAt: now + 30_000 },
    );
    const forged = {
      ...envelope,
      records: [{ ...metadataInput(), sequence: 2 }],
    };

    expect(
      verifyAuthenticatedMetadataIngestEnvelope(
        forged,
        scopedCredential,
        identity,
        { now },
      ),
    ).toMatchObject({
      ok: false,
      code: "metadata_ingest.fingerprint_mismatch",
    });
    expect(
      verifyAuthenticatedMetadataIngestEnvelope(
        envelope,
        scopedCredential,
        { ...identity, connectionId: "other" },
        { now },
      ),
    ).toMatchObject({
      ok: false,
      code: "metadata_ingest.wrong_connection",
    });
  });

  it("scopes dedupe and reduction to every authenticated identity dimension", () => {
    const identity = {
      tenantId: "tenant-1",
      environment: "production",
      adapterId: "adapter-1",
      connectionId: "connection-1",
    };
    const record = canonicalizeMetadataRecord(metadataInput(), identity);
    const duplicate = canonicalizeMetadataRecord(metadataInput(), identity);
    const otherConnection = canonicalizeMetadataRecord(metadataInput(), {
      ...identity,
      connectionId: "connection-2",
    });
    const callerHint = canonicalizeMetadataRecord(
      metadataInput({ sourceDedupeKey: "caller-hint" }),
      identity,
    );
    const delivered = canonicalizeMetadataRecord(
      metadataInput({
        status: "delivered",
        responseStatusCode: 200,
        durationMilliseconds: 25,
      }),
      identity,
    );
    const explicitOptionalValues = canonicalizeMetadataRecord(
      metadataInput({
        durationMilliseconds: 0,
        retryable: false,
        occurredAt: "2026-07-01T00:00:00.500Z",
      }),
      identity,
    );

    expect(validateCanonicalMetadataRecord(record).ok).toBe(true);
    expect(deliveryAttemptDedupeKey(record)).toBe(
      deliveryAttemptDedupeKey(duplicate),
    );
    expect(deliveryAttemptDedupeKey(record)).not.toBe(
      deliveryAttemptDedupeKey(otherConnection),
    );
    expect(deliveryAttemptDedupeKey(record)).not.toBe(
      deliveryAttemptDedupeKey(callerHint),
    );
    expect(deliveryAttemptDedupeKey(record)).not.toBe(
      deliveryAttemptDedupeKey(delivered),
    );
    expect(deliveryAttemptDedupeKey(record)).not.toBe(
      deliveryAttemptDedupeKey(explicitOptionalValues),
    );
    const state = reduceDeliveryAttempt(undefined, record);
    expect(reduceDeliveryAttempt(state, duplicate)).toBe(state);
    const enrichedOptionalState = reduceDeliveryAttempt(
      state,
      explicitOptionalValues,
    );
    expect(enrichedOptionalState.current).toMatchObject({
      durationMilliseconds: 0,
      retryable: false,
    });
    const deliveredState = reduceDeliveryAttempt(state, delivered);
    expect(deliveredState.current).toMatchObject({
      attempt: 1,
      sequence: 1,
      status: "delivered",
      responseStatusCode: 200,
    });
    expect(reduceDeliveryAttempt(deliveredState, delivered)).toBe(
      deliveredState,
    );
    const failed = canonicalizeMetadataRecord(
      metadataInput({
        status: "failed",
        errorCode: "timeout",
        occurredAt: "2026-07-01T00:00:01.000Z",
      }),
      identity,
    );
    const enrichedFailure = canonicalizeMetadataRecord(
      metadataInput({
        status: "failed",
        errorCode: "connection_refused",
        occurredAt: "2026-07-01T00:00:02.000Z",
      }),
      identity,
    );
    const failedState = reduceDeliveryAttempt(undefined, failed);
    const enrichedState = reduceDeliveryAttempt(failedState, enrichedFailure);
    expect(enrichedState.current.errorCode).toBe("connection_refused");
    expect(reduceDeliveryAttempt(enrichedState, enrichedFailure)).toBe(
      enrichedState,
    );
    expect(() => reduceDeliveryAttempt(state, otherConnection)).toThrow(
      /different tenant/iu,
    );
  });
});

describe("deadline and secret primitives", () => {
  it("rejects an already-expired deadline before invoking the task", async () => {
    let calls = 0;
    await expect(
      withDeadline(Date.now() - 1, async () => {
        calls += 1;
        return "must-not-run";
      }),
    ).rejects.toBeInstanceOf(AdapterDeadlineError);
    expect(calls).toBe(0);
  });

  it("allows a near-boundary task to start and propagates parent abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let nearBoundaryCalls = 0;
    await expect(
      withDeadline(now + 1, async (signal) => {
        nearBoundaryCalls += 1;
        expect(signal.aborted).toBe(false);
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(nearBoundaryCalls).toBe(1);

    const parent = new AbortController();
    let abortObserved = false;
    const pending = withDeadline(
      now + 1_000,
      async (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      parent.signal,
    );
    const reason = new Error("parent aborted");
    parent.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(abortObserved).toBe(true);
  });

  it("does not invoke the task when the parent signal is already aborted", async () => {
    const parent = new AbortController();
    const reason = new Error("already aborted");
    parent.abort(reason);
    let calls = 0;
    await expect(
      withDeadline(
        Date.now() + 1_000,
        async () => {
          calls += 1;
        },
        parent.signal,
      ),
    ).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  it("propagates deadline cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const deadline = createDeadlineSignal(deadlineAfter(10));
    await vi.advanceTimersByTimeAsync(11);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.didTimeout()).toBe(true);
  });

  it("redacts secrets and supports operation-aware unknown retry policy", () => {
    const plaintext = "top-secret-913";
    const secret = new SecretValue(plaintext, {
      id: "secret-1",
      purpose: "webhook_signing",
    });
    for (const output of [
      String(secret),
      JSON.stringify(secret),
      inspect(secret),
    ]) {
      expect(output).not.toContain(plaintext);
      expect(output).toContain(REDACTED_SECRET);
    }
    expect(redactSecrets({ secret })).toEqual({
      secret: {
        id: "secret-1",
        purpose: "webhook_signing",
        type: "SecretValue",
        value: REDACTED_SECRET,
      },
    });
    const secretCredential = credential([
      "secret.create",
      "secret.rotate_with_overlap",
    ]);
    const createEnvelope = createAuthenticatedCommandEnvelope(
      {
        kind: "secret.create",
        context: createAdapterContext({
          tenant: { id: "tenant-1" },
          environment: { id: "production" },
          connection: { id: "connection-1" },
          actor: { id: "actor-1", type: "service" },
          idempotency: { key: "secret-create-envelope" },
          credential: secretCredential,
          deadline: now + 30_000,
        }),
        input: {
          endpoint: { id: "endpoint-1" },
          material: { label: "webhook signing", value: secret },
        },
      },
      secretCredential,
      { issuedAt: now, nonce: "secret-create-nonce" },
    );
    const rotateEnvelope = createAuthenticatedCommandEnvelope(
      {
        kind: "secret.rotate_with_overlap",
        context: createAdapterContext({
          tenant: { id: "tenant-1" },
          environment: { id: "production" },
          connection: { id: "connection-1" },
          actor: { id: "actor-1", type: "service" },
          idempotency: { key: "secret-rotate-envelope" },
          credential: secretCredential,
          deadline: now + 30_000,
        }),
        input: {
          secret: { id: "secret-1" },
          overlapUntil: "2027-01-15T08:00:00.000Z",
          replacement: secret,
        },
      },
      secretCredential,
      { issuedAt: now, nonce: "secret-rotate-nonce" },
    );
    const serializedEnvelopes = JSON.parse(
      JSON.stringify({
        createEnvelope,
        rotateEnvelope,
      }),
    ) as unknown;
    const redactedEnvelopes = redactSecrets({
      serializedEnvelopes,
      publicFields: {
        material: { value: "public-material-value" },
        replacement: "public-replacement-value",
      },
      wrongOperation: {
        kind: "endpoint.update",
        input: {
          material: { value: "public-command-material" },
          replacement: "public-command-replacement",
        },
      },
      rawCommand: {
        kind: "secret.create",
        input: {
          material: { value: plaintext },
        },
      },
    });
    expect(JSON.stringify(redactedEnvelopes)).not.toContain(plaintext);
    expect(redactedEnvelopes).toMatchObject({
      serializedEnvelopes: {
        createEnvelope: {
          command: {
            input: {
              material: {
                label: "webhook signing",
                value: REDACTED_SECRET,
              },
            },
          },
        },
        rotateEnvelope: {
          command: {
            input: { replacement: REDACTED_SECRET },
          },
        },
      },
      publicFields: {
        material: { value: "public-material-value" },
        replacement: "public-replacement-value",
      },
      wrongOperation: {
        input: {
          material: { value: "public-command-material" },
          replacement: "public-command-replacement",
        },
      },
      rawCommand: {
        input: { material: { value: REDACTED_SECRET } },
      },
    });
    expect(
      unknownResult("send timeout", undefined, { retryable: false }),
    ).toMatchObject({
      status: "unknown",
      retryable: false,
    });
    expect(
      hasSameSecretMaterial(
        new SecretValue("same-material", { id: "one" }),
        new SecretValue("same-material", { id: "two" }),
      ),
    ).toBe(true);
    expect(
      hasSameSecretMaterial(
        new SecretValue("same-material"),
        new SecretValue("different-material"),
      ),
    ).toBe(false);
  });

  it("derives printable ASCII digest keys for durable command replay", () => {
    const identityKey = commandReplayIdentityStorageKey({
      credentialId: "credential-🔑",
      tenantId: "ténant",
      environment: "production",
      connectionId: "connection-東京",
      idempotencyKey: "idempotency-ñ",
    });
    const nonceKey = commandReplayNonceStorageKey(
      "credential-🔑",
      "nonce-東京",
    );
    expect(identityKey).toMatch(/^whp_command_replay_[a-f0-9]{64}$/u);
    expect(nonceKey).toMatch(/^whp_command_nonce_[a-f0-9]{64}$/u);
    for (const key of [identityKey, nonceKey]) {
      expect(key).toMatch(/^[\x21-\x7e]+$/u);
    }
  });

  describe("RFC 8785 Unicode well-formedness", () => {
    const loneHigh = JSON.parse('"\\ud800"') as string;
    const loneLow = JSON.parse('"\\udc00"') as string;

    it("rejects lone surrogates in values, keys, IDs, secrets, and metadata before canonicalization", () => {
      const scopedCredential = credential(["endpoint.create"]);
      const base = endpointCommand(scopedCredential);
      for (const malformed of [loneHigh, loneLow]) {
        expect(isWellFormedUnicode(malformed)).toBe(false);
        expect(() => new SecretValue(malformed)).toThrow(/unpaired/iu);
        expect(
          isProviderNativeRef({
            provider: "provider",
            resourceType: "delivery",
            id: malformed,
          }),
        ).toBe(false);
        expect(() =>
          createAdapterContext({
            tenant: { id: malformed },
            environment: { id: "production" },
            connection: { id: "connection-1" },
            actor: { id: "actor-1", type: "service" },
            idempotency: { key: "unicode-key" },
            deadline: now + 30_000,
          }),
        ).toThrow(/well-formed|safe string/iu);

        const valueCommand = {
          ...base,
          input: {
            endpoint: {
              ...base.input.endpoint,
              description: malformed,
            },
          },
        };
        const keyCommand = {
          ...base,
          input: {
            endpoint: {
              ...base.input.endpoint,
              labels: { [malformed]: "value" },
            },
          },
        };
        expect(() => computeAdapterCommandFingerprint(valueCommand)).toThrow(
          /unpaired/iu,
        );
        expect(() =>
          createAuthenticatedCommandEnvelope(keyCommand, scopedCredential, {
            issuedAt: now,
            nonce: "unicode-nonce",
          }),
        ).toThrow(/unpaired/iu);
        expect(
          validateMetadataDeliveryAttemptInput(
            metadataInput({ sourceDedupeKey: malformed }),
          ).ok,
        ).toBe(false);
        expect(() =>
          createAuthenticatedMetadataIngestEnvelope(
            [metadataInput({ sourceDedupeKey: malformed })],
            {
              tenantId: "tenant-1",
              environment: "production",
              adapterId: "adapter-1",
              connectionId: "connection-1",
            },
            "unicode-batch",
            credential(["metadata.ingest"]),
            { issuedAt: now, expiresAt: now + 30_000 },
          ),
        ).toThrow();
      }
    });

    it("rejects malformed verification input but accepts supplementary-plane Unicode", () => {
      const scopedCredential = credential(["endpoint.create"]);
      const valid = createAuthenticatedCommandEnvelope(
        endpointCommand(scopedCredential),
        scopedCredential,
        { issuedAt: now, nonce: "verification-nonce" },
      );
      const malformed = {
        ...valid,
        command: {
          ...valid.command,
          input: {
            endpoint: {
              id: "endpoint-1",
              url: "https://receiver.example/webhooks",
              description: loneHigh,
            },
          },
        },
      };
      expect(
        verifyAuthenticatedCommandEnvelope(
          malformed,
          scopedCredential,
          {
            adapterId: "adapter-1",
            tenantId: "tenant-1",
            environment: "production",
            connectionId: "connection-1",
            operation: "endpoint.create",
            host: "api.example.com",
          },
          { now },
        ),
      ).toMatchObject({ ok: false, code: "envelope.invalid" });

      expect(isWellFormedUnicode("invoice.😀")).toBe(true);
      expect(() =>
        createAuthenticatedCommandEnvelope(
          {
            ...endpointCommand(scopedCredential),
            input: {
              endpoint: {
                id: "endpoint-😀",
                url: "https://receiver.example/webhooks",
                labels: { "emoji-😀": "supplementary-🛰️" },
              },
            },
          },
          scopedCredential,
          { issuedAt: now, nonce: "emoji-nonce-😀" },
        ),
      ).not.toThrow();
    });
  });

  it("checks connection-aware credential scope", () => {
    const scopedCredential = credential(["endpoint.create"]);
    expect(
      checkCredentialScope(scopedCredential, {
        adapterId: "adapter-1",
        connectionId: "connection-1",
        tenantId: "tenant-1",
        environment: "production",
        purpose: "endpoint.create",
        role: "command",
        host: "api.example.com",
        now,
      }),
    ).toEqual({ ok: true });
    expect(
      checkCredentialScope(scopedCredential, {
        adapterId: "adapter-1",
        connectionId: "connection-1",
        tenantId: "tenant-1",
        environment: "production",
        purpose: "endpoint.create",
        role: "command",
        now,
      }),
    ).toEqual({ ok: false, reason: "host_scope_mismatch" });
    expect(
      checkCredentialScope(scopedCredential, {
        adapterId: "adapter-1",
        connectionId: "connection-1",
        tenantId: "tenant-1",
        environment: "production",
        purpose: "endpoint.create",
        role: "command",
        host: "wrong.example.com",
        now,
      }),
    ).toEqual({ ok: false, reason: "host_scope_mismatch" });
    expect(
      checkCredentialScope(
        {
          ...scopedCredential,
          scope: { ...scopedCredential.scope, hosts: [] },
        },
        {
          adapterId: "adapter-1",
          connectionId: "connection-1",
          tenantId: "tenant-1",
          environment: "production",
          purpose: "endpoint.create",
          role: "command",
          now,
        },
      ),
    ).toEqual({ ok: true });
    expect(
      checkCredentialScope(scopedCredential, {
        adapterId: "adapter-1",
        connectionId: "other",
        tenantId: "tenant-1",
        environment: "production",
        purpose: "endpoint.create",
        role: "command",
        host: "api.example.com",
        now,
      }),
    ).toEqual({ ok: false, reason: "connection_scope_mismatch" });
  });
});
