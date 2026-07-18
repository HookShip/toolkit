// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalJsonAsset,
  createExtensionBundle,
  normalizeExtensionManifestDraft,
  serializeExtensionBundle,
  signExtensionBundle,
  verifyExtensionBundle,
} from "../../packages/extension-sdk/dist/index.js";

const extensionsRoot = fileURLToPath(new URL("..", import.meta.url));
const developmentKeyDirectory = path.join(
  extensionsRoot,
  "test-fixtures",
  "development-signing-key",
);

export const DEVELOPMENT_KEY_ID =
  "webhook-portal-development-test-key-rfc8032-1";

export const PACK_SPECS = Object.freeze([
  Object.freeze({
    id: "webhook-portal.connector.aws-event-destinations",
    kind: "connector",
    relativeDirectory: "connectors/aws-event-destinations",
  }),
  Object.freeze({
    id: "webhook-portal.transform.canonical-metadata-envelope",
    kind: "transform",
    relativeDirectory: "transforms/canonical-metadata-envelope",
  }),
  Object.freeze({
    id: "webhook-portal.policy.metadata-protection-baseline",
    kind: "policy",
    relativeDirectory: "policies/metadata-protection-baseline",
  }),
  Object.freeze({
    id: "webhook-portal.template.ai-async-callbacks",
    kind: "template",
    relativeDirectory: "templates/ai-async-callbacks",
  }),
]);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadDeclaredAssets(directory, manifest) {
  const files = [];
  const visit = async (currentDirectory) => {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const metadata = await lstat(absolutePath);
      assert.equal(metadata.isSymbolicLink(), false);
      if (metadata.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.mode & 0o111, 0);
      files.push(
        path.relative(directory, absolutePath).split(path.sep).join("/"),
      );
    }
  };
  await visit(directory);

  const declaredPaths = manifest.resources.map((resource) => resource.path);
  assert.deepEqual(files, declaredPaths);

  return Promise.all(
    manifest.resources.map(async (resource) => {
      const bytes = await readFile(path.join(directory, resource.path));
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      assert.equal(Buffer.from(content, "utf8").equals(bytes), true);
      const normalizedContent =
        resource.mediaType === "application/json" ||
        resource.mediaType === "application/schema+json"
          ? canonicalJsonAsset(JSON.parse(content))
          : content;
      return {
        path: resource.path,
        mediaType: resource.mediaType,
        content: normalizedContent,
      };
    }),
  );
}

export async function developmentTrustPolicy() {
  const publicKey = await readFile(
    path.join(developmentKeyDirectory, "development-public.pem"),
    "utf8",
  );
  return Object.freeze({
    minimumSignatures: 1,
    rejectUnknownSignatures: true,
    requiredKeyIds: Object.freeze([DEVELOPMENT_KEY_ID]),
    keys: Object.freeze([
      Object.freeze({
        keyId: DEVELOPMENT_KEY_ID,
        publicKey,
        status: "active",
      }),
    ]),
  });
}

export async function buildPack(spec) {
  const packDirectory = path.join(extensionsRoot, spec.relativeDirectory);
  const manifest = normalizeExtensionManifestDraft(
    await readJson(path.join(packDirectory, "manifest.source.json")),
  );
  assert.equal(manifest.identity.id, spec.id);
  assert.equal(manifest.kind, spec.kind);
  assert.equal(manifest.provenance.build.reproducible, true);

  const unsignedBundle = createExtensionBundle({
    manifest,
    assets: await loadDeclaredAssets(
      path.join(packDirectory, "assets"),
      manifest,
    ),
  });
  const privateKey = await readFile(
    path.join(developmentKeyDirectory, "DO-NOT-USE-IN-PRODUCTION-private.pem"),
    "utf8",
  );
  const bundle = signExtensionBundle(unsignedBundle, {
    keyId: DEVELOPMENT_KEY_ID,
    privateKey,
  });
  const trustPolicy = await developmentTrustPolicy();
  const verification = verifyExtensionBundle(bundle, { trustPolicy });
  if (!verification.ok) {
    throw new Error(
      `${spec.id} failed development verification: ${verification.issues
        .map((issue) => issue.code)
        .join(", ")}`,
    );
  }
  return Object.freeze({
    bundle,
    manifest,
    packDirectory,
    serialized: serializeExtensionBundle(bundle),
    trustPolicy,
    verification,
  });
}

export async function buildAllPacks() {
  return Promise.all(PACK_SPECS.map((spec) => buildPack(spec)));
}

function parseArguments(arguments_) {
  let checkOnly = false;
  let outputDirectory = path.join(extensionsRoot, "dist");
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      checkOnly = true;
      continue;
    }
    if (argument === "--output") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("--output requires a directory.");
      }
      outputDirectory = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { checkOnly, outputDirectory };
}

async function runCli() {
  const { checkOnly, outputDirectory } = parseArguments(process.argv.slice(2));
  const firstBuild = await buildAllPacks();
  const secondBuild = await buildAllPacks();

  for (let index = 0; index < firstBuild.length; index += 1) {
    const first = firstBuild[index];
    const second = secondBuild[index];
    assert.equal(first.serialized, second.serialized);
    assert.equal(
      first.bundle.manifest.integrity.bundleDigest,
      second.bundle.manifest.integrity.bundleDigest,
    );

    if (!checkOnly) {
      await mkdir(outputDirectory, { recursive: true });
      const fileName = `${first.manifest.identity.id}-${first.manifest.identity.version}.extension.json`;
      await writeFile(
        path.join(outputDirectory, fileName),
        first.serialized,
        "utf8",
      );
    }

    const action = checkOnly ? "verified" : "built";
    console.log(
      `${action} ${first.manifest.identity.id}@${first.manifest.identity.version} ${first.bundle.manifest.integrity.bundleDigest}`,
    );
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await runCli();
}
