// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CANONICAL_METADATA_SCHEMA_VERSION,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  InMemoryCommandEnvelopeReplayStore,
  SecretValue,
  createAdapterContext,
  createAuthenticatedCommandEnvelope,
  createAuthenticatedMetadataIngestEnvelope,
  completeCommandEnvelopeReplay,
  okResult,
  verifyAuthenticatedCommandEnvelopeWithReplay,
  type AdapterCommand,
  type AdapterCommandResult,
  type MetadataDeliveryAttemptInput,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

import {
  assertAdapterConformance,
  runAdapterConformance,
  type AdapterConformanceFixture,
} from "../../adapter-conformance/src/index.js";
import {
  createAuthenticatedProviderAcknowledgement,
  GenericHttpAdapter,
  InMemoryAcknowledgementReplayStore,
  InMemoryIdempotencyStore,
  MetadataIngestVerifier,
  verifyProviderAcknowledgement,
  type HttpTransport,
  type HttpTransportRequest,
} from "../src/index.js";

function envelope(request: HttpTransportRequest): Record<string, unknown> {
  const encoded =
    request.body === undefined
      ? request.headers["x-webhook-command-envelope"]
      : Buffer.from(request.body).toString("utf8");
  if (encoded === undefined) {
    throw new Error("Missing envelope.");
  }
  return JSON.parse(
    request.body === undefined
      ? Buffer.from(encoded, "base64url").toString("utf8")
      : encoded,
  ) as Record<string, unknown>;
}

function metadataInput(): MetadataDeliveryAttemptInput {
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
  };
}

describe("real generic HTTP adapter conformance", () => {
  it("passes mandatory auth, deadline, durable idempotency, metadata, and side-effect probes", async () => {
    const store = new InMemoryIdempotencyStore();
    let effects = 0;
    let cancelled = false;
    let counter = 0;
    const acknowledgementReplayStore = new InMemoryAcknowledgementReplayStore();
    const scopedCredential: ScopedCredential = {
      id: "credential-1",
      kind: "bearer",
      role: "command",
      secret: new SecretValue("generic-conformance-secret"),
      scope: {
        adapterId: "generic-conformance",
        connectionId: "connection-1",
        tenantId: "tenant-1",
        environments: ["test"],
        operations: ["endpoint.create", "metadata.poll"],
        hosts: ["api.example.com"],
        expiresAt: Date.now() + 600_000,
      },
    };
    const responseCredential: ScopedCredential = {
      id: "response-credential-1",
      kind: "header",
      role: "response",
      secret: new SecretValue("generic-response-secret"),
      scope: {
        adapterId: "generic-conformance",
        connectionId: "connection-1",
        tenantId: "tenant-1",
        environments: ["test"],
        operations: ["acknowledgement.verify"],
        expiresAt: Date.now() + 600_000,
      },
    };
    const transport: HttpTransport = async (request) => {
      const signed = envelope(request);
      if (request.url.pathname.endsWith("/metadata")) {
        return {
          status: 200,
          body: JSON.stringify({
            records: [metadataInput()],
            hasMore: false,
          }),
        };
      }
      effects += 1;
      if (String(signed["idempotencyKey"]).startsWith("deadline-")) {
        return new Promise((_resolve, reject) => {
          let observed = false;
          const abort = (): void => {
            if (observed) return;
            observed = true;
            cancelled = true;
            reject(request.signal.reason);
          };
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) {
            abort();
          }
        });
      }
      return {
        status: 201,
        body: JSON.stringify(
          createAuthenticatedProviderAcknowledgement(
            {
              operation: "endpoint.create",
              connectionId: "connection-1",
              tenantId: "tenant-1",
              environment: "test",
              requestNonce: signed["nonce"] as string,
              idempotencyKey: signed["idempotencyKey"] as string,
              commandFingerprint: signed["commandFingerprint"] as string,
              disposition: "completed",
              mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
              result: {
                kind: "resource",
                resource: {
                  type: "endpoint",
                  id: "endpoint-1",
                  state: "active",
                },
              },
            },
            responseCredential,
          ),
        ),
      };
    };
    const makeAdapter = (): GenericHttpAdapter =>
      new GenericHttpAdapter({
        adapter: {
          id: "generic-conformance",
          name: "Generic conformance",
          version: "1.0.0",
        },
        connectionId: "connection-1",
        baseUrl: "https://api.example.com/",
        routes: {
          "endpoint.create": { method: "POST", path: "endpoints" },
          "metadata.poll": { method: "GET", path: "metadata" },
        },
        destination: {
          allowedHosts: ["api.example.com"],
          resolver: async () => [{ address: "8.8.8.8", family: 4 }],
        },
        idempotencyStore: store,
        responseCredential,
        acknowledgementReplayStore,
        transport,
      });
    const adapter = makeAdapter();

    const command = (
      kind: "endpoint.create" | "endpoint.delete" | "metadata.poll",
      key: string,
      timeout = 5_000,
    ): AdapterCommand => {
      const context = createAdapterContext({
        tenant: { id: "tenant-1" },
        environment: { id: "test" },
        connection: { id: "connection-1" },
        actor: { id: "actor-1", type: "service" },
        idempotency: { key },
        credential: scopedCredential,
        deadline: Date.now() + timeout,
      });
      if (kind === "metadata.poll") {
        return { kind, context, input: { limit: 10 } };
      }
      if (kind === "endpoint.delete") {
        return { kind, context, input: { endpoint: { id: "endpoint-1" } } };
      }
      return {
        kind,
        context,
        input: {
          endpoint: {
            id: "endpoint-1",
            url: "https://receiver.example/webhooks",
          },
        },
      };
    };

    const fixture: AdapterConformanceFixture = {
      name: "Generic HTTP",
      adapter,
      commands: {
        "endpoint.create": () =>
          command("endpoint.create", `success-${counter++}`),
        "endpoint.delete": () =>
          command("endpoint.delete", `unsupported-${counter++}`),
        "metadata.poll": () =>
          command("metadata.poll", `metadata-${counter++}`),
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
        command: () => command("endpoint.create", "idempotency-fixed"),
        retryCommand: () => command("endpoint.create", "idempotency-fixed"),
        restart: () => makeAdapter(),
      },
      deadline: {
        command: () => command("endpoint.create", `deadline-${counter++}`, 500),
        wasCancelled: () => cancelled,
      },
      security: {
        async commandAuthentication() {
          const issuedAt = Date.now();
          const candidate = command(
            "endpoint.create",
            `security-command-${counter++}`,
          );
          const signed = createAuthenticatedCommandEnvelope(
            candidate,
            scopedCredential,
            {
              issuedAt,
              nonce: "command-security-nonce",
            },
          );
          const expected = {
            adapterId: "generic-conformance",
            tenantId: "tenant-1",
            environment: "test",
            connectionId: "connection-1",
            operation: "endpoint.create" as const,
            host: "api.example.com",
          };
          const options = {
            now: issuedAt,
            storeDeadlineAt: issuedAt + 1_000,
            replayRetentionMilliseconds: 60_000,
          };
          const store = new InMemoryCommandEnvelopeReplayStore({
            clock: () => issuedAt,
          });
          const accepted = await verifyAuthenticatedCommandEnvelopeWithReplay(
            signed,
            scopedCredential,
            expected,
            store,
            options,
          );
          const duplicate = await verifyAuthenticatedCommandEnvelopeWithReplay(
            signed,
            scopedCredential,
            expected,
            store,
            options,
          );
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
          if (accepted.ok && accepted.status === "accepted") {
            await completeCommandEnvelopeReplay(store, accepted, storedResult, {
              deadlineAt: issuedAt + 1_000,
            });
          }
          const replay = await verifyAuthenticatedCommandEnvelopeWithReplay(
            signed,
            scopedCredential,
            expected,
            store,
            options,
          );
          const conflicting = createAuthenticatedCommandEnvelope(
            {
              kind: "endpoint.create",
              context: candidate.context,
              input: {
                endpoint: {
                  id: "different-endpoint",
                  url: "https://receiver.example/webhooks",
                },
              },
            },
            scopedCredential,
            {
              issuedAt,
              nonce: "command-conflict-nonce",
            },
          );
          const conflict = await verifyAuthenticatedCommandEnvelopeWithReplay(
            conflicting,
            scopedCredential,
            expected,
            store,
            options,
          );
          const concurrentStore = new InMemoryCommandEnvelopeReplayStore({
            clock: () => issuedAt,
          });
          const concurrent = await Promise.all(
            Array.from({ length: 3 }, () =>
              verifyAuthenticatedCommandEnvelopeWithReplay(
                signed,
                scopedCredential,
                expected,
                concurrentStore,
                options,
              ),
            ),
          );
          return {
            receiverVerified: accepted.ok && accepted.status === "accepted",
            duplicateRejected:
              !duplicate.ok && duplicate.code === "envelope.replay_in_progress",
            storedResultReplayed:
              replay.ok &&
              replay.status === "replay" &&
              replay.result === storedResult,
            conflictingReplayRejected:
              !conflict.ok && conflict.code === "envelope.replay_conflict",
            concurrentConsumeSafe:
              concurrent.filter(
                (result) => result.ok && result.status === "accepted",
              ).length === 1,
            forgedRejected: !(
              await verifyAuthenticatedCommandEnvelopeWithReplay(
                {
                  ...signed,
                  signature: {
                    ...signed.signature,
                    value: "A".repeat(43),
                  },
                },
                scopedCredential,
                expected,
                new InMemoryCommandEnvelopeReplayStore(),
                options,
              )
            ).ok,
            expiredRejected: !(
              await verifyAuthenticatedCommandEnvelopeWithReplay(
                signed,
                scopedCredential,
                expected,
                new InMemoryCommandEnvelopeReplayStore(),
                {
                  ...options,
                  now: candidate.context.deadline.at + 1,
                },
              )
            ).ok,
            wrongScopeRejected: !(
              await verifyAuthenticatedCommandEnvelopeWithReplay(
                signed,
                scopedCredential,
                { ...expected, tenantId: "other-tenant" },
                new InMemoryCommandEnvelopeReplayStore(),
                options,
              )
            ).ok,
          };
        },
        async acknowledgementAuthentication() {
          const issuedAt = Date.now();
          const candidate = command(
            "endpoint.create",
            `security-ack-${counter++}`,
          );
          const signedCommand = createAuthenticatedCommandEnvelope(
            candidate,
            scopedCredential,
            {
              issuedAt,
              nonce: "ack-request-nonce",
            },
          );
          const binding = {
            adapterId: "generic-conformance",
            operation: "endpoint.create" as const,
            connectionId: "connection-1",
            tenantId: "tenant-1",
            environment: "test",
            requestNonce: signedCommand.nonce,
            idempotencyKey: candidate.context.idempotency.key,
            commandFingerprint: signedCommand.commandFingerprint,
            mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
            expectedResourceId: "endpoint-1",
          };
          const signed = createAuthenticatedProviderAcknowledgement(
            {
              operation: binding.operation,
              connectionId: binding.connectionId,
              tenantId: binding.tenantId,
              environment: binding.environment,
              requestNonce: binding.requestNonce,
              idempotencyKey: binding.idempotencyKey,
              commandFingerprint: binding.commandFingerprint,
              disposition: "completed",
              mappingVersion: binding.mappingVersion,
              result: {
                kind: "resource",
                resource: {
                  type: "endpoint",
                  id: "endpoint-1",
                  state: "active",
                },
              },
            },
            responseCredential,
            {
              issuedAt,
              expiresAt: issuedAt + 30_000,
              nonce: "ack-response-nonce",
            },
          );
          const replayStore = new InMemoryAcknowledgementReplayStore();
          const signedVerified = (
            await verifyProviderAcknowledgement(
              signed,
              binding,
              responseCredential,
              replayStore,
              { now: issuedAt },
            )
          ).ok;
          const replayedRejected = !(
            await verifyProviderAcknowledgement(
              signed,
              binding,
              responseCredential,
              replayStore,
              { now: issuedAt },
            )
          ).ok;
          const freshStore = () => new InMemoryAcknowledgementReplayStore();
          const wrongScopeCredential = {
            ...responseCredential,
            scope: {
              ...responseCredential.scope,
              tenantId: "other-tenant",
            },
          };
          const { signature, ...unsigned } = signed;
          return {
            signedVerified,
            replayedRejected,
            forgedRejected: !(
              await verifyProviderAcknowledgement(
                {
                  ...signed,
                  signature: { ...signature, value: "A".repeat(43) },
                },
                binding,
                responseCredential,
                freshStore(),
                { now: issuedAt },
              )
            ).ok,
            modifiedRejected: !(
              await verifyProviderAcknowledgement(
                {
                  ...signed,
                  result: {
                    kind: "resource",
                    resource: {
                      type: "endpoint",
                      id: "other-endpoint",
                      state: "active",
                    },
                  },
                },
                binding,
                responseCredential,
                freshStore(),
                { now: issuedAt },
              )
            ).ok,
            expiredRejected: !(
              await verifyProviderAcknowledgement(
                signed,
                binding,
                responseCredential,
                freshStore(),
                { now: issuedAt + 31_000 },
              )
            ).ok,
            wrongKeyRejected: !(
              await verifyProviderAcknowledgement(
                signed,
                binding,
                { ...responseCredential, id: "wrong-key" },
                freshStore(),
                { now: issuedAt },
              )
            ).ok,
            wrongScopeRejected: !(
              await verifyProviderAcknowledgement(
                signed,
                binding,
                wrongScopeCredential,
                freshStore(),
                { now: issuedAt },
              )
            ).ok,
            unsignedRejected: !(
              await verifyProviderAcknowledgement(
                unsigned,
                binding,
                responseCredential,
                freshStore(),
                { now: issuedAt },
              )
            ).ok,
          };
        },
        async metadataIngest() {
          const issuedAt = Date.now();
          const identity = {
            tenantId: "tenant-1",
            environment: "test",
            adapterId: "generic-conformance",
            connectionId: "connection-1",
          };
          const metadataCredential: ScopedCredential = {
            id: "metadata-credential-1",
            kind: "header",
            role: "metadata_ingest",
            secret: new SecretValue("metadata-ingest-secret"),
            scope: {
              ...identity,
              environments: ["test"],
              operations: ["metadata.ingest"],
              expiresAt: issuedAt + 60_000,
            },
          };
          const signed = createAuthenticatedMetadataIngestEnvelope(
            [metadataInput()],
            identity,
            "security-batch",
            metadataCredential,
            {
              issuedAt,
              expiresAt: issuedAt + 30_000,
            },
          );
          const verifier = new MetadataIngestVerifier({
            identity,
            credential: metadataCredential,
            clock: () => issuedAt,
          });
          const valid = verifier.verify(signed);
          const forged = verifier.verify({
            ...signed,
            records: [{ ...metadataInput(), sequence: 99 }],
          });
          const wrongScope = new MetadataIngestVerifier({
            identity,
            credential: {
              ...metadataCredential,
              scope: {
                ...metadataCredential.scope,
                tenantId: "other-tenant",
              },
            },
            clock: () => issuedAt,
          }).verify(signed);
          return {
            signedVerified: valid.ok,
            forgedRejected: !forged.ok,
            wrongScopeRejected: !wrongScope.ok,
            identityDerived:
              valid.ok &&
              valid.records[0]?.tenantId === identity.tenantId &&
              valid.records[0]?.connectionId === identity.connectionId,
          };
        },
      },
    };

    const report = await runAdapterConformance(fixture);
    expect(report.passed, JSON.stringify(report.results)).toBe(true);
    expect(report.skipped).toBe(0);
    expect(() => assertAdapterConformance(report)).not.toThrow();
  });
});
