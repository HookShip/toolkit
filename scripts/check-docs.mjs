// SPDX-License-Identifier: Apache-2.0
//
// Offline documentation validation for the toolkit repository. Uses only the
// Node standard library and git, performs no network access, and enforces:
//
// 1. Every relative Markdown link resolves to a file that exists.
// 2. Every HookShip GitHub reference points at one of the four real HookShip
//    repositories; no other org repository, product URL, contact email, or
//    availability/SLA claim is invented (the org's pre-release posture).
// 3. Cross-repo navigation is present: the docs link the organization's
//    repository-placement, source-of-truth, and release policies and reference
//    hook-service's delivery data-plane role.
//
// Run: `node scripts/check-docs.mjs` from the repository root.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The only HookShip repositories that exist; any other is an invented URL.
export const verifiedRepos = new Set([
  ".github",
  "toolkit",
  "hook-service",
  "platform",
]);

const orgBlob = "https://github.com/HookShip/.github/blob/main";

// Cross-repo navigation that toolkit documentation must expose.
export const requiredNavigation = [
  `${orgBlob}/REPOSITORY_PLACEMENT.md`,
  `${orgBlob}/SOURCE_OF_TRUTH.md`,
  `${orgBlob}/RELEASE_POLICY.md`,
  "https://github.com/HookShip/hook-service",
];

// A phrase that must appear so hook-service's role is stated, not just linked.
export const hookServiceRolePhrase = "delivery data plane";

const markdownLink = /\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;
const hookshipRef = /github\.com\/HookShip\/([A-Za-z0-9._-]+)/g;
const emailRef = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// High-confidence availability/SLA assertions (a percentage next to an
// availability word); the pre-release docs make no such claim.
const availabilityClaim =
  /\b\d{1,3}(?:\.\d+)?\s*%\s*(?:uptime|availability|sla)/i;
const gaClaim = /\bgenerally available\b/i;

// Inline-code references to concrete workspace source files must resolve, so a
// moved, renamed, or deleted symbol cannot leave a stale path behind in prose
// (Markdown link targets are validated separately by checkLinks). Generated and
// installed trees are excluded because they do not exist until a build/install.
const workspaceFileReference =
  /^(?:packages|apps|scripts|infra|examples|extensions|release|docs)\/[A-Za-z0-9._/-]+\.(?:ts|mjs|cjs|js|sql|sh|json|ya?ml)$/;
const generatedPathSegment =
  /(?:^|\/)(?:dist|node_modules|coverage|\.turbo|\.release-work|\.pack-smoke-work)(?:\/|$)/;
const inlineCodeSpan = /`([^`\n]+)`/g;

// Critical commands, environment variables, and ports the docs depend on. Each
// anchor must still be present in the cited source of truth, so renaming one in
// code fails this check until the docs are updated in step.
export const criticalCodeAnchors = [
  {
    token: "3210",
    file: "packages/reference-server-core/src/types.ts",
    label: "reference server default port",
  },
  {
    token: "REFERENCE_API_TOKEN",
    file: "packages/reference-server-core/src/runtime.ts",
    label: "reference API token environment variable",
  },
  {
    token: "DATABASE_URL",
    file: "packages/reference-server-core/src/runtime.ts",
    label: "reference database URL environment variable",
  },
  {
    token: "test:integration:reference",
    file: "package.json",
    label: "reference integration npm script",
  },
];

// Reserved documentation domains that are never real endpoints.
const allowedExampleHosts =
  /(?:^|[/@.])(?:example\.(?:com|org|net)|example-[a-z-]+\.internal|localhost|127\.0\.0\.1)(?:$|[/:])/i;

export function trackedMarkdownFiles() {
  // Include tracked and untracked-but-not-ignored Markdown so a new doc is
  // validated before it is committed, mirroring the secret-hygiene scanner.
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.md"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}

// Removes fenced and inline code so example URLs, commands, and payloads inside
// code samples do not trip the prose checks.
export function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export function verifyHookshipRepo(reference) {
  // reference is the captured repo segment, e.g. "toolkit" or "toolkit.git".
  const repo = reference.replace(/\.git$/, "");
  return verifiedRepos.has(repo);
}

export function checkLinks(relativeFile, text) {
  const failures = [];
  const prose = stripCode(text);
  for (const match of prose.matchAll(markdownLink)) {
    const target = match[1].trim();
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const local = target.split("#", 1)[0];
    if (local === "") continue;
    const resolved = path.resolve(
      path.dirname(path.join(root, relativeFile)),
      local,
    );
    if (!existsSync(resolved)) {
      failures.push(`${relativeFile}: broken relative link to ${target}`);
    }
  }
  return failures;
}

export function checkNoInventedReferences(relativeFile, text) {
  const failures = [];
  // HookShip repo references are checked in full text (including code) so an
  // invented repo cannot hide inside an example.
  for (const match of text.matchAll(hookshipRef)) {
    if (!verifyHookshipRepo(match[1])) {
      failures.push(
        `${relativeFile}: reference to non-existent HookShip repository "${match[1]}"`,
      );
    }
  }
  const prose = stripCode(text);
  for (const match of prose.matchAll(emailRef)) {
    if (!allowedExampleHosts.test(match[0])) {
      failures.push(
        `${relativeFile}: unexpected contact email "${match[0]}" (pre-release docs invent no contacts)`,
      );
    }
  }
  if (availabilityClaim.test(prose)) {
    failures.push(
      `${relativeFile}: availability/SLA percentage claim (pre-release makes no such claim)`,
    );
  }
  if (gaClaim.test(prose)) {
    failures.push(
      `${relativeFile}: "generally available" claim (pre-release makes no such claim)`,
    );
  }
  return failures;
}

export function checkWorkspacePathReferences(relativeFile, text) {
  const failures = [];
  const seen = new Set();
  for (const match of text.matchAll(inlineCodeSpan)) {
    const candidate = match[1].trim();
    if (seen.has(candidate)) {
      continue;
    }
    if (
      !workspaceFileReference.test(candidate) ||
      generatedPathSegment.test(candidate)
    ) {
      continue;
    }
    seen.add(candidate);
    if (!existsSync(path.join(root, candidate))) {
      failures.push(
        `${relativeFile}: inline reference to missing workspace file \`${candidate}\` (moved, renamed, or deleted?)`,
      );
    }
  }
  return failures;
}

export async function checkCriticalAnchors() {
  const failures = [];
  for (const anchor of criticalCodeAnchors) {
    const absolute = path.join(root, anchor.file);
    if (!existsSync(absolute)) {
      failures.push(
        `critical ${anchor.label} anchor file is missing: ${anchor.file}`,
      );
      continue;
    }
    const source = await readFile(absolute, "utf8");
    if (!source.includes(anchor.token)) {
      failures.push(
        `critical ${anchor.label} "${anchor.token}" is no longer present in ${anchor.file}; documentation may be stale`,
      );
    }
  }
  return failures;
}

export function checkNavigation(corpus) {
  const failures = [];
  for (const target of requiredNavigation) {
    if (!corpus.includes(target)) {
      failures.push(`documentation must link cross-repo navigation: ${target}`);
    }
  }
  if (!corpus.toLowerCase().includes(hookServiceRolePhrase)) {
    failures.push(
      `documentation must describe hook-service's role ("${hookServiceRolePhrase}")`,
    );
  }
  return failures;
}

export async function checkDocs() {
  const files = trackedMarkdownFiles();
  const failures = [];
  let corpus = "";
  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8");
    corpus += `\n${text}`;
    failures.push(...checkLinks(file, text));
    failures.push(...checkNoInventedReferences(file, text));
    failures.push(...checkWorkspacePathReferences(file, text));
  }
  failures.push(...checkNavigation(corpus));
  failures.push(...(await checkCriticalAnchors()));
  return failures.sort();
}

async function main() {
  const failures = await checkDocs();
  if (failures.length > 0) {
    console.error("Documentation validation failures:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "Documentation links resolve, cross-repo navigation is present, and no contacts, SLAs, or invented URLs were found.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
