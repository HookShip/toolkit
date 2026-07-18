// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HARD_BUNDLE_LIMITS,
  canonicalJson,
  canonicalJsonAsset,
  canonicalJsonDigest,
  createExtensionBundle,
  normalizeExtensionManifestDraft,
  packExtensionDirectory,
  parseCanonicalJson,
  parseExtensionBundle,
  parseExtensionBundleJson,
  serializeExtensionBundle,
  signExtensionBundle,
  verifyExtensionBundle,
  type JsonValue,
} from "../src/index.js";

import { makeBundle, makeManifestDraft, transformProgram } from "./fixtures.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workRoot = path.join(packageRoot, ".test-work");

beforeEach(async () => {
  await rm(workRoot, { force: true, recursive: true });
  await mkdir(workRoot, { recursive: true });
});

afterEach(async () => {
  await rm(workRoot, { force: true, recursive: true });
});

describe("closed canonical manifests", () => {
  it("normalizes a complete closed manifest and rejects unknown fields", () => {
    const draft = makeManifestDraft();
    expect(draft.manifestVersion).toBe("1.0");
    expect(Object.isFrozen(draft)).toBe(true);
    expect(() =>
      normalizeExtensionManifestDraft({ ...draft, runtime: "javascript" }),
    ).toThrow(/unknown field/u);
    expect(() =>
      normalizeExtensionManifestDraft({
        ...draft,
        identity: { ...draft.identity, executable: "index.js" },
      }),
    ).toThrow(/unknown field/u);
  });

  it("uses locale-independent UTF-16 ordering and rejects malformed Unicode", () => {
    const value = {
      "😀": "supplementary",
      z: 1,
      ä: 2,
      İ: 3,
      i: 4,
    };
    const first = canonicalJsonDigest(value);
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(canonicalJsonDigest(reordered)).toBe(first);
    expect(canonicalJson(value)).toContain('"😀"');
    expect(() => canonicalJson(JSON.parse('"\\ud800"'))).toThrow(
      /unpaired UTF-16 surrogate/u,
    );
  });

  it("rejects non-canonical and duplicate-key JSON text", () => {
    expect(parseCanonicalJson('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
    expect(() => parseCanonicalJson('{ "a": 1 }')).toThrow(
      /not in canonical form/u,
    );
    expect(() => parseCanonicalJson('{"a":1,"a":2}')).toThrow(
      /not in canonical form/u,
    );
  });
});

describe("data-only bundles and signatures", () => {
  it("produces reproducible bundle and content digests", () => {
    const left = makeBundle({ kind: "connector" });
    const right = createExtensionBundle({
      manifest: makeManifestDraft({ kind: "connector" }),
      assets: [...left.assets]
        .reverse()
        .map(({ path: assetPath, mediaType, content }) => ({
          path: assetPath,
          mediaType,
          content,
        })),
    });
    expect(right.manifest.integrity).toEqual(left.manifest.integrity);
    expect(serializeExtensionBundle(right)).toBe(
      serializeExtensionBundle(left),
    );
    expect(left.assets.every((asset) => asset.encoding === "utf8")).toBe(true);
    const serialized = serializeExtensionBundle(left);
    expect(parseExtensionBundleJson(serialized)).toEqual(left);
    expect(() => parseExtensionBundleJson(` ${serialized}`)).toThrow(
      /not in canonical form/u,
    );
  });

  it("supports Ed25519 rotation, thresholds, and revocation", () => {
    const oldKey = generateKeyPairSync("ed25519");
    const nextKey = generateKeyPairSync("ed25519");
    const signed = signExtensionBundle(
      signExtensionBundle(makeBundle(), {
        keyId: "publisher-old",
        privateKey: oldKey.privateKey,
      }),
      {
        keyId: "publisher-next",
        privateKey: nextKey.privateKey,
      },
    );
    const overlap = verifyExtensionBundle(signed, {
      trustPolicy: {
        minimumSignatures: 2,
        allowRetiredKeys: true,
        keys: [
          {
            keyId: "publisher-old",
            publicKey: oldKey.publicKey,
            status: "retired",
            replacementKeyId: "publisher-next",
          },
          {
            keyId: "publisher-next",
            publicKey: nextKey.publicKey,
            status: "active",
          },
        ],
      },
    });
    expect(overlap.ok).toBe(true);
    expect(overlap.validKeyIds).toEqual(["publisher-next", "publisher-old"]);

    const revoked = verifyExtensionBundle(signed, {
      trustPolicy: {
        minimumSignatures: 2,
        keys: [
          {
            keyId: "publisher-old",
            publicKey: oldKey.publicKey,
            status: "revoked",
          },
          {
            keyId: "publisher-next",
            publicKey: nextKey.publicKey,
            status: "active",
          },
        ],
      },
    });
    expect(revoked.ok).toBe(false);
    expect(revoked.signatureErrors.map((issue) => issue.code)).toContain(
      "KEY_REVOKED",
    );
    expect(revoked.signatureErrors.map((issue) => issue.code)).toContain(
      "THRESHOLD_NOT_MET",
    );
  });

  it("detects signature tampering and content replacement", () => {
    const key = generateKeyPairSync("ed25519");
    const signed = signExtensionBundle(makeBundle(), {
      keyId: "publisher-key",
      privateKey: key.privateKey,
    });
    const [signature] = signed.manifest.integrity.signatures;
    expect(signature).toBeDefined();
    const changedSignature = `${
      signature?.signature.startsWith("A") ? "B" : "A"
    }${signature?.signature.slice(1)}`;
    const malformed = {
      ...signed,
      manifest: {
        ...signed.manifest,
        integrity: {
          ...signed.manifest.integrity,
          signatures: [{ ...signature, signature: changedSignature }],
        },
      },
    };
    const tampered = verifyExtensionBundle(malformed, {
      trustPolicy: {
        keys: [
          {
            keyId: "publisher-key",
            publicKey: key.publicKey,
            status: "active",
          },
        ],
      },
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.signatureErrors.map((issue) => issue.code)).toContain(
      "INVALID_SIGNATURE",
    );

    const replacementProgram = {
      ...transformProgram,
      operations: [
        ...transformProgram.operations,
        { op: "set", path: "/tampered", value: true },
      ],
    };
    const replacement = createExtensionBundle({
      manifest: makeManifestDraft(),
      assets: [
        {
          path: "transform.json",
          mediaType: "application/json",
          content: canonicalJsonAsset(
            replacementProgram as unknown as JsonValue,
          ),
        },
      ],
    });
    const replaced = parseExtensionBundle({
      ...replacement,
      manifest: {
        ...replacement.manifest,
        integrity: {
          ...replacement.manifest.integrity,
          signatures: signed.manifest.integrity.signatures,
        },
      },
    });
    const replacementResult = verifyExtensionBundle(replaced, {
      trustPolicy: {
        keys: [
          {
            keyId: "publisher-key",
            publicKey: key.publicKey,
            status: "active",
          },
        ],
      },
    });
    expect(replacementResult.ok).toBe(false);
    expect(
      replacementResult.signatureErrors.map((issue) => issue.code),
    ).toContain("SIGNED_DIGEST_MISMATCH");
  });

  it("rejects traversal, duplicate paths, executable forms, and bomb-like data", () => {
    const draft = makeManifestDraft();
    const content = canonicalJsonAsset(
      transformProgram as unknown as JsonValue,
    );
    expect(() =>
      createExtensionBundle({
        manifest: draft,
        assets: [
          {
            path: "../transform.json",
            mediaType: "application/json",
            content,
          },
        ],
      }),
    ).toThrow(/unsafe path segment/u);
    expect(() =>
      normalizeExtensionManifestDraft({
        ...draft,
        resources: [
          ...draft.resources,
          { ...draft.resources[0], path: "TRANSFORM.JSON" },
        ],
      }),
    ).toThrow(/Duplicate or case-colliding/u);
    expect(() =>
      normalizeExtensionManifestDraft({
        ...draft,
        resources: [{ path: "program.js", mediaType: "text/plain" }],
        entry: { type: "transform", program: "program.js" },
      }),
    ).toThrow(/executable file suffix/u);
    expect(() =>
      createExtensionBundle({
        manifest: draft,
        assets: [
          {
            path: "transform.json",
            mediaType: "application/json",
            content: "x".repeat(HARD_BUNDLE_LIMITS.maximumAssetBytes + 1),
          },
        ],
      }),
    ).toThrow(/length|byte limit/u);
    expect(() =>
      parseExtensionBundle({
        ...makeBundle(),
        compression: "gzip",
      }),
    ).toThrow(/unknown field/u);
  });
});

describe("directory packer", () => {
  async function writeDeclared(
    directory: string,
    content: string | Uint8Array = canonicalJsonAsset(
      transformProgram as unknown as JsonValue,
    ),
  ): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "transform.json"), content);
  }

  it("packs only declared regular UTF-8 data files", async () => {
    const directory = path.join(workRoot, "valid");
    await writeDeclared(directory);
    const bundle = await packExtensionDirectory({
      directory,
      manifest: makeManifestDraft(),
    });
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.assets[0]?.path).toBe("transform.json");
  });

  it("rejects unlisted files", async () => {
    const directory = path.join(workRoot, "unlisted");
    await writeDeclared(directory);
    await writeFile(path.join(directory, "extra.txt"), "extra");
    await expect(
      packExtensionDirectory({
        directory,
        manifest: makeManifestDraft(),
      }),
    ).rejects.toThrow(/not listed/u);
  });

  it("rejects symlinks, executable bits, and binary files", async () => {
    const source = path.join(workRoot, "source.json");
    await writeFile(
      source,
      canonicalJsonAsset(transformProgram as unknown as JsonValue),
    );
    const symlinkDirectory = path.join(workRoot, "symlink");
    await mkdir(symlinkDirectory);
    await symlink(source, path.join(symlinkDirectory, "transform.json"));
    await expect(
      packExtensionDirectory({
        directory: symlinkDirectory,
        manifest: makeManifestDraft(),
      }),
    ).rejects.toThrow(/symlink/u);

    const executableDirectory = path.join(workRoot, "executable");
    await writeDeclared(executableDirectory);
    await chmod(path.join(executableDirectory, "transform.json"), 0o755);
    await expect(
      packExtensionDirectory({
        directory: executableDirectory,
        manifest: makeManifestDraft(),
      }),
    ).rejects.toThrow(/executable permission/u);

    const binaryDirectory = path.join(workRoot, "binary");
    await writeDeclared(binaryDirectory, Buffer.from([0xff, 0x00, 0x01, 0x80]));
    await expect(
      packExtensionDirectory({
        directory: binaryDirectory,
        manifest: makeManifestDraft(),
      }),
    ).rejects.toThrow(/canonical UTF-8|binary/u);
  });
});
