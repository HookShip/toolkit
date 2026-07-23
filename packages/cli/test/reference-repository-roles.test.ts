// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  InMemoryReferenceRepository,
  type AuditOutboxRepository,
  type ContractRepository,
  type EndpointRepository,
  type PayloadRepository,
  type ReferenceRepositoryTransaction,
  type ReleaseRepository,
  type SecretRepository,
  type TestCommandRepository,
  type TimelineRepository,
} from "../src/reference-server/index.js";

// Compile-time proof that the composed repository still satisfies every
// segregated role interface. Narrowing to a role must not require a cast.
function acceptsRoles(repository: ReferenceRepositoryTransaction): void {
  const contracts: ContractRepository = repository;
  const releases: ReleaseRepository = repository;
  const endpoints: EndpointRepository = repository;
  const secrets: SecretRepository = repository;
  const testCommands: TestCommandRepository = repository;
  const timeline: TimelineRepository = repository;
  const auditOutbox: AuditOutboxRepository = repository;
  const payloads: PayloadRepository = repository;
  void [
    contracts,
    releases,
    endpoints,
    secrets,
    testCommands,
    timeline,
    auditOutbox,
    payloads,
  ];
}

const ROLE_METHODS: Readonly<Record<string, readonly string[]>> = {
  contracts: ["createContractImport", "getContractImport"],
  releases: [
    "lockReleaseState",
    "publishRelease",
    "getActiveRelease",
    "listReleaseMetadataPage",
    "completePublishCommand",
  ],
  endpoints: [
    "createEndpoint",
    "updateEndpoint",
    "deleteEndpointData",
    "setSubscription",
    "getSubscription",
  ],
  secrets: [
    "createSecretVersion",
    "rotateSecret",
    "revokeSecret",
    "listSecretVersions",
  ],
  testCommands: [
    "beginTestCommand",
    "markTestCommandDispatched",
    "stageTestCommandResult",
    "completeTestCommand",
  ],
  timeline: ["acquireTimelineEvidenceLocks", "ingestMetadata", "listTimeline"],
  auditOutbox: ["appendAudit", "listAudit", "appendOutbox", "listOutbox"],
  payloads: [
    "createPayloadReference",
    "claimPayloadCleanup",
    "beginPayloadCleanupDeletion",
    "finalizePayloadCleanupDeletion",
    "completePayloadCleanup",
  ],
};

describe("segregated reference repository roles", () => {
  const repository = new InMemoryReferenceRepository();
  acceptsRoles(repository);

  it.each(Object.entries(ROLE_METHODS))(
    "implements the %s role surface",
    (_role, methods) => {
      for (const method of methods) {
        expect(
          typeof (repository as unknown as Record<string, unknown>)[method],
        ).toBe("function");
      }
    },
  );
});
