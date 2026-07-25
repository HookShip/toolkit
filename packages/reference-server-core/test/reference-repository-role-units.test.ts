// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { InMemoryEndpointRepository } from "../src/memory/memory-endpoint-repository.js";
import { InMemoryRepositoryState } from "../src/memory/memory-repository-state.js";
import { InMemoryTimelineAuditRepository } from "../src/memory/memory-timeline-audit-repository.js";

/**
 * Constructs the segregated role classes directly on a shared state object
 * (instead of through the composed facade) to prove the composition seam: role
 * modules created after the God-class split still read and write the one
 * underlying state, and each role satisfies its interface on its own.
 */
describe("directly composed in-memory repository roles", () => {
  it("shares one state across independently constructed endpoint roles", async () => {
    const state = new InMemoryRepositoryState();
    const endpoints = new InMemoryEndpointRepository(state);

    const created = await endpoints.createEndpoint({
      id: "ep_1",
      createdAt: "2026-07-16T08:00:00.000Z",
      url: "https://example.com/hook",
      allowLocalNetwork: false,
    });
    expect(created.id).toBe("ep_1");
    expect(created.state).toBe("active");

    // A second role instance over the same state observes the write.
    const observer = new InMemoryEndpointRepository(state);
    expect((await observer.getEndpoint("ep_1"))?.state).toBe("active");

    const updated = await endpoints.updateEndpoint("ep_1", {
      updatedAt: "2026-07-16T08:05:00.000Z",
      state: "paused",
    });
    expect(updated?.state).toBe("paused");
    expect((await observer.getEndpoint("ep_1"))?.state).toBe("paused");
    expect(await endpoints.listEndpoints()).toHaveLength(1);
  });

  it("appends and lists audit and outbox records through its own role", async () => {
    const state = new InMemoryRepositoryState();
    const timelineAudit = new InMemoryTimelineAuditRepository(state);

    await timelineAudit.appendAudit({
      id: "aud_1",
      createdAt: "2026-07-16T08:00:00.000Z",
      action: "endpoint.create",
      resourceType: "endpoint",
      resourceId: "ep_1",
      result: "success",
      actorId: "local-user",
      correlationId: "corr_1",
    });
    await timelineAudit.appendOutbox({
      id: "out_1",
      createdAt: "2026-07-16T08:00:00.000Z",
      topic: "endpoint.created",
      aggregateType: "endpoint",
      aggregateId: "ep_1",
      correlationId: "corr_1",
      payload: { endpointId: "ep_1" },
    });

    const audit = await timelineAudit.listAudit(10);
    const outbox = await timelineAudit.listOutbox(10);
    expect(audit.map((record) => record.id)).toContain("aud_1");
    expect(outbox.map((record) => record.id)).toContain("out_1");
  });
});
