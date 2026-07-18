// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const locales = ["C", "en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"];

const script = String.raw`
import {
  canonicalJsonDigest,
  createExtensionBundle,
  createExampleTransformManifest,
  EXAMPLE_TRANSFORM_ASSET,
  normalizePermissionSet,
} from "./dist/index.js";

const permissions = normalizePermissionSet({
  metadataRead: ["/z", "/ä", "/İ", "/i", "/😀"],
  outboundHosts: ["api.example.com"],
});
const bundle = createExtensionBundle({
  manifest: createExampleTransformManifest(),
  assets: [{
    path: "transform.json",
    mediaType: "application/json",
    content: EXAMPLE_TRANSFORM_ASSET,
  }],
});
console.log(JSON.stringify({
  json: canonicalJsonDigest({ "ä": 1, z: 2, "İ": 3, i: 4, "😀": 5 }),
  permissions: permissions.metadataRead,
  content: bundle.manifest.integrity.contentDigest,
  bundle: bundle.manifest.integrity.bundleDigest,
}));
`;

function outputForLocale(locale: string): string {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale },
      timeout: 15_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("cross-locale reproducibility", () => {
  it("keeps canonical, permission, content, and bundle digests identical", () => {
    const outputs = locales.map((locale) => outputForLocale(locale));
    expect(new Set(outputs).size).toBe(1);
    expect(JSON.parse(outputs[0] ?? "{}")).toMatchObject({
      json: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      content: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      bundle: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      permissions: ["/i", "/z", "/ä", "/İ", "/😀"],
    });
  }, 60_000);
});
