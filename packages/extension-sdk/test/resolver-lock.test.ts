// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ResolutionError,
  canonicalJson,
  compareSemVer,
  createInstallationLock,
  createInstallationPermissionGrant,
  parseSemVer,
  parseSemVerRange,
  resolveExtensions,
  satisfiesSemVer,
  verifyInstallationLock,
} from "../src/index.js";

import { makeBundle } from "./fixtures.js";

describe("bounded semver subset", () => {
  it("supports exact, comparator, caret, tilde, wildcard, and OR ranges", () => {
    expect(satisfiesSemVer("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfiesSemVer("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesSemVer("1.4.2", "~1.4.0")).toBe(true);
    expect(satisfiesSemVer("1.5.0", "~1.4.0")).toBe(false);
    expect(satisfiesSemVer("1.9.0", "1.x")).toBe(true);
    expect(satisfiesSemVer("2.1.0", ">=1.0.0 <2.0.0 || 2.1.0")).toBe(true);
    expect(compareSemVer("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  });

  it("rejects malformed and unbounded input", () => {
    expect(() => parseSemVer("01.0.0")).toThrow(/canonical numeric/u);
    expect(() => parseSemVer("1.0")).toThrow(/major, minor, and patch/u);
    expect(() => parseSemVerRange("||")).toThrow(/empty alternative/u);
    expect(() =>
      parseSemVerRange("x || x || x || x || x || x || x || x || x"),
    ).toThrow(/too many/u);
  });
});

describe("deterministic dependency resolution", () => {
  const libraryV1 = makeBundle({
    id: "example.library",
    version: "1.0.0",
  }).manifest;
  const libraryV2 = makeBundle({
    id: "example.library",
    version: "2.0.0",
  }).manifest;
  const root = makeBundle({
    id: "example.root",
    version: "1.0.0",
    dependencies: [
      { id: "example.library", range: ">=1.0.0 <3.0.0", optional: false },
    ],
  }).manifest;

  it("selects the highest compatible graph independent of input order", () => {
    const request = {
      platformVersion: "1.2.0",
      sdkVersion: "0.1.0",
      roots: [{ id: "example.root", range: "^1.0.0" }],
    };
    const left = resolveExtensions({
      ...request,
      available: [libraryV1, root, libraryV2],
    });
    const right = resolveExtensions({
      ...request,
      available: [libraryV2, root, libraryV1],
    });
    expect(left.nodes.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: "example.library", version: "2.0.0" },
      { id: "example.root", version: "1.0.0" },
    ]);
    expect(canonicalJson(left as never)).toBe(canonicalJson(right as never));
    expect(left.edges).toEqual([
      {
        from: "example.root",
        to: "example.library",
        range: ">=1.0.0 <3.0.0",
        optional: false,
      },
    ]);
  });

  it("emits explicit upgrade and pinned rollback decisions", () => {
    const upgrade = resolveExtensions({
      available: [libraryV1, libraryV2],
      installed: [
        {
          id: "example.library",
          version: "1.0.0",
          bundleDigest: libraryV1.integrity.bundleDigest,
        },
      ],
      platformVersion: "1.2.0",
      sdkVersion: "0.1.0",
      roots: [{ id: "example.library", range: "*" }],
    });
    expect(upgrade.decisions).toEqual([
      {
        id: "example.library",
        kind: "upgrade",
        pinned: false,
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
      },
    ]);

    const rollback = resolveExtensions({
      available: [libraryV1, libraryV2],
      installed: [
        {
          id: "example.library",
          version: "2.0.0",
          bundleDigest: libraryV2.integrity.bundleDigest,
        },
      ],
      pins: { "example.library": "1.0.0" },
      platformVersion: "1.2.0",
      sdkVersion: "0.1.0",
      roots: [{ id: "example.library", range: "*" }],
    });
    expect(rollback.decisions).toEqual([
      {
        id: "example.library",
        kind: "rollback",
        pinned: true,
        fromVersion: "2.0.0",
        toVersion: "1.0.0",
      },
    ]);
  });

  it("rejects dependency cycles and declared conflicts", () => {
    const cycleA = makeBundle({
      id: "cycle.a",
      dependencies: [{ id: "cycle.b", range: "*", optional: false }],
    }).manifest;
    const cycleB = makeBundle({
      id: "cycle.b",
      dependencies: [{ id: "cycle.a", range: "*", optional: false }],
    }).manifest;
    expect(() =>
      resolveExtensions({
        available: [cycleA, cycleB],
        platformVersion: "1.0.0",
        sdkVersion: "0.1.0",
        roots: [{ id: "cycle.a", range: "*" }],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ResolutionError>>({
        code: "DEPENDENCY_CYCLE",
      }),
    );

    const conflictingRoot = makeBundle({
      id: "conflict.root",
      dependencies: [{ id: "conflict.library", range: "*", optional: false }],
      conflicts: [
        {
          id: "conflict.library",
          range: "*",
          reason: "Mutually exclusive behavior.",
        },
      ],
    }).manifest;
    const conflictingLibrary = makeBundle({
      id: "conflict.library",
    }).manifest;
    expect(() =>
      resolveExtensions({
        available: [conflictingRoot, conflictingLibrary],
        platformVersion: "1.0.0",
        sdkVersion: "0.1.0",
        roots: [{ id: "conflict.root", range: "*" }],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ResolutionError>>({
        code: "DEPENDENCY_CONFLICT",
      }),
    );
  });

  it("creates canonical installation locks with provenance and grant checksums", () => {
    const resolution = resolveExtensions({
      available: [root, libraryV1, libraryV2],
      pins: { "example.library": "1.0.0" },
      platformVersion: "1.2.0",
      sdkVersion: "0.1.0",
      roots: [{ id: "example.root", range: "*" }],
    });
    const grants = resolution.nodes.map((node) =>
      createInstallationPermissionGrant({
        bundleDigest: node.bundleDigest,
        extensionId: node.id,
        grantId: `grant/${node.id}`,
        issuer: "control-plane",
        requested: node.manifest.permissions,
        granted: node.manifest.permissions,
      }),
    );
    const input = {
      createdAt: "2026-07-18T00:00:00.000Z",
      platformVersion: "1.2.0",
      sdkVersion: "0.1.0",
      resolution,
      grants,
    };
    const left = createInstallationLock(input);
    const right = createInstallationLock(input);
    expect(left).toEqual(right);
    expect(verifyInstallationLock(left)).toMatchObject({ ok: true });
    expect(
      left.extensions.every((extension) =>
        extension.provenanceDigest.startsWith("sha256:"),
      ),
    ).toBe(true);
    expect(
      verifyInstallationLock({
        ...left,
        platformVersion: "1.3.0",
      }),
    ).toMatchObject({
      ok: false,
      issues: ["Installation lock checksum does not match."],
    });
  });
});
