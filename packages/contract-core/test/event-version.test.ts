// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  CanonicalContract,
  CanonicalEventType,
  CanonicalEventVersion,
  JsonObject,
} from "@webhook-portal/canonical-model";

import { selectCanonicalEventVersion } from "../src/event-version.js";

function version(
  publicVersion: string,
  extensions?: JsonObject,
): CanonicalEventVersion {
  return {
    examples: [],
    extensions,
    id: `evt.v${publicVersion}`,
    publicVersion,
  } as unknown as CanonicalEventVersion;
}

function eventType(partial: {
  readonly externalName: string;
  readonly id?: string;
  readonly extensions?: JsonObject;
  readonly versions: readonly CanonicalEventVersion[];
}): CanonicalEventType {
  return {
    extensions: partial.extensions,
    externalName: partial.externalName,
    id: partial.id ?? partial.externalName,
    versions: partial.versions,
  } as unknown as CanonicalEventType;
}

function contractWith(
  ...eventTypes: readonly CanonicalEventType[]
): CanonicalContract {
  return { eventTypes } as unknown as CanonicalContract;
}

describe("selectCanonicalEventVersion", () => {
  it("reports event_not_found for an unknown event name", () => {
    const contract = contractWith(
      eventType({ externalName: "order.created", versions: [version("1")] }),
    );
    expect(selectCanonicalEventVersion(contract, "missing.event")).toEqual({
      availableVersions: [],
      status: "event_not_found",
    });
  });

  it("matches an event by canonical id as well as external name", () => {
    const contract = contractWith(
      eventType({
        externalName: "Order Created",
        id: "order.created",
        versions: [version("1")],
      }),
    );
    const byId = selectCanonicalEventVersion(contract, "order.created");
    const byName = selectCanonicalEventVersion(contract, "Order Created");
    expect(byId.status).toBe("found");
    expect(byName.status).toBe("found");
  });

  it("resolves an explicitly requested public version", () => {
    const contract = contractWith(
      eventType({
        externalName: "order.created",
        versions: [version("1"), version("2")],
      }),
    );
    const result = selectCanonicalEventVersion(contract, "order.created", "2");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.version.publicVersion).toBe("2");
    }
  });

  it("reports event_not_found when the requested version is absent", () => {
    const contract = contractWith(
      eventType({
        externalName: "order.created",
        versions: [version("1"), version("2")],
      }),
    );
    expect(selectCanonicalEventVersion(contract, "order.created", "9")).toEqual(
      {
        availableVersions: ["1", "2"],
        status: "event_not_found",
      },
    );
  });

  it("auto-selects the single available version", () => {
    const contract = contractWith(
      eventType({ externalName: "order.created", versions: [version("7")] }),
    );
    const result = selectCanonicalEventVersion(contract, "order.created");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.version.publicVersion).toBe("7");
    }
  });

  it("honours an event-level current-version marker", () => {
    const contract = contractWith(
      eventType({
        extensions: { "x-webhook-portal-current-version": "2" },
        externalName: "order.created",
        versions: [version("1"), version("2")],
      }),
    );
    const result = selectCanonicalEventVersion(contract, "order.created");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.version.publicVersion).toBe("2");
    }
  });

  it("honours the legacy x-current-version marker alias", () => {
    const contract = contractWith(
      eventType({
        extensions: { "x-current-version": "1" },
        externalName: "order.created",
        versions: [version("1"), version("2")],
      }),
    );
    const result = selectCanonicalEventVersion(contract, "order.created");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.version.publicVersion).toBe("1");
    }
  });

  it("honours a version-level current marker", () => {
    const contract = contractWith(
      eventType({
        externalName: "order.created",
        versions: [
          version("1"),
          version("2", { "x-webhook-portal-current": true }),
        ],
      }),
    );
    const result = selectCanonicalEventVersion(contract, "order.created");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.version.publicVersion).toBe("2");
    }
  });

  it("ignores a version marker that is not literally true", () => {
    const contract = contractWith(
      eventType({
        externalName: "order.created",
        versions: [
          version("1", { "x-current": false }),
          version("2", { "x-current": "yes" }),
        ],
      }),
    );
    expect(selectCanonicalEventVersion(contract, "order.created").status).toBe(
      "version_required",
    );
  });

  it("flags an event-level marker that names a missing version", () => {
    const contract = contractWith(
      eventType({
        extensions: { "x-webhook-portal-current-version": "99" },
        externalName: "order.created",
        versions: [version("1"), version("2")],
      }),
    );
    expect(selectCanonicalEventVersion(contract, "order.created")).toEqual({
      availableVersions: ["1", "2"],
      event: expect.anything(),
      status: "invalid_current_version",
    });
  });

  it("flags ambiguous multi-marked current versions", () => {
    const contract = contractWith(
      eventType({
        externalName: "order.created",
        versions: [
          version("1", { "x-webhook-portal-current": true }),
          version("2", { "x-webhook-portal-current": true }),
        ],
      }),
    );
    expect(selectCanonicalEventVersion(contract, "order.created").status).toBe(
      "invalid_current_version",
    );
  });

  it("requires an explicit version when multiple exist without markers", () => {
    const contract = contractWith(
      eventType({
        externalName: "order.created",
        versions: [version("1"), version("2")],
      }),
    );
    expect(selectCanonicalEventVersion(contract, "order.created")).toEqual({
      availableVersions: ["1", "2"],
      event: expect.anything(),
      status: "version_required",
    });
  });

  it("ignores an empty-string event-level marker", () => {
    const contract = contractWith(
      eventType({
        extensions: { "x-webhook-portal-current-version": "" },
        externalName: "order.created",
        versions: [version("1"), version("2")],
      }),
    );
    expect(selectCanonicalEventVersion(contract, "order.created").status).toBe(
      "version_required",
    );
  });
});
