// SPDX-License-Identifier: Apache-2.0
//
// Production dependency vulnerability gate. Runs `pnpm audit` scoped to
// production dependencies and fails closed on any high- or critical-severity
// advisory that is not covered by an explicit, reviewed, non-expired exception
// in scripts/vulnerability-allowlist.json.
//
// Policy (deterministic, never silently ignored):
//   * Only production dependencies are considered (`--prod`); dev-only tooling
//     advisories do not block a release.
//   * Only `high` and `critical` severities block by default.
//   * The only escape hatch is the in-repo allowlist, where each entry needs a
//     GHSA id, a reason, and an ISO expiry date. An expired-but-still-present
//     exception fails the gate; an exception that no longer matches any advisory
//     is reported so it can be removed.
//
// This gate needs network access to the registry advisory API and is therefore
// wired into CI and the release verify job rather than the offline `pnpm check`.
//
// Run: `node scripts/check-vulnerabilities.mjs` (or `pnpm check:audit`).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const blockingSeverities = new Set(["high", "critical"]);

export function advisoryEntries(auditReport) {
  const advisories = auditReport?.advisories ?? {};
  return Object.values(advisories).map((advisory) => ({
    id: String(advisory.github_advisory_id ?? advisory.id ?? "unknown"),
    module: advisory.module_name ?? "unknown",
    severity: String(advisory.severity ?? "unknown").toLowerCase(),
    title: advisory.title ?? "",
    vulnerable: advisory.vulnerable_versions ?? "",
    patched: advisory.patched_versions ?? "",
    url:
      advisory.url ??
      (advisory.github_advisory_id
        ? `https://github.com/advisories/${advisory.github_advisory_id}`
        : ""),
  }));
}

// Pure policy evaluation, independent of how the audit was produced, so it can
// be unit tested with fixtures. `now` is injected for deterministic expiry.
export function evaluateAudit(auditReport, allowlist, now = new Date()) {
  const failures = [];
  const ignored = [];
  const warnings = [];

  const ignore = Array.isArray(allowlist?.ignore) ? allowlist.ignore : [];
  const byGhsa = new Map(
    ignore
      .filter((entry) => entry && typeof entry.ghsa === "string")
      .map((entry) => [entry.ghsa, entry]),
  );
  const usedGhsas = new Set();

  for (const advisory of advisoryEntries(auditReport)) {
    if (!blockingSeverities.has(advisory.severity)) continue;
    const exception = byGhsa.get(advisory.id);
    if (!exception) {
      failures.push(
        `${advisory.severity} ${advisory.module} (${advisory.id}): ${advisory.title} [vulnerable ${advisory.vulnerable}, patched ${advisory.patched}] ${advisory.url}`,
      );
      continue;
    }
    usedGhsas.add(advisory.id);
    const expires = Date.parse(exception.expires ?? "");
    if (!Number.isFinite(expires)) {
      failures.push(
        `${advisory.module} (${advisory.id}): allowlist exception has no valid ISO "expires" date`,
      );
      continue;
    }
    if (expires < now.getTime()) {
      failures.push(
        `${advisory.module} (${advisory.id}): allowlist exception expired on ${exception.expires}; re-review or remediate`,
      );
      continue;
    }
    ignored.push(
      `${advisory.severity} ${advisory.module} (${advisory.id}) ignored until ${exception.expires}: ${exception.reason ?? "no reason given"}`,
    );
  }

  for (const entry of ignore) {
    if (entry?.ghsa && !usedGhsas.has(entry.ghsa)) {
      warnings.push(
        `allowlist entry ${entry.ghsa} matched no current production advisory; remove it if the vulnerability is resolved`,
      );
    }
  }

  return { failures, ignored, warnings };
}

// Extracts high/critical advisories present in the full (all-scope) audit but
// absent from the production audit — i.e. development-only tooling advisories.
// They are surfaced for visibility so they are never silently ignored, but they
// never block the production-scoped gate.
export function devOnlyBlockingAdvisories(allReport, prodReport) {
  const prodIds = new Set(advisoryEntries(prodReport).map((entry) => entry.id));
  return advisoryEntries(allReport).filter(
    (advisory) =>
      blockingSeverities.has(advisory.severity) && !prodIds.has(advisory.id),
  );
}

function runAudit({ prod }) {
  return new Promise((resolve) => {
    const args = prod ? ["audit", "--prod", "--json"] : ["audit", "--json"];
    let stdout = "";
    let stderr = "";
    const child = spawn("pnpm", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) =>
      resolve({ code: -1, stdout, stderr: String(error) }),
    );
    // `pnpm audit` exits non-zero when advisories exist; the JSON is still on
    // stdout, so the exit code is not used to decide pass/fail.
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const allowlist = JSON.parse(
    await readFile(
      path.join(root, "scripts", "vulnerability-allowlist.json"),
      "utf8",
    ),
  );

  const prodResult = await runAudit({ prod: true });
  let prodReport;
  try {
    prodReport = JSON.parse(prodResult.stdout);
  } catch {
    console.error(
      "Production vulnerability gate could not run pnpm audit (no parseable JSON). This gate requires registry network access.",
    );
    if (prodResult.stderr.trim()) console.error(prodResult.stderr.trim());
    process.exitCode = 1;
    return;
  }

  const { failures, ignored, warnings } = evaluateAudit(prodReport, allowlist);

  // Non-blocking visibility: report any high/critical advisory that affects only
  // development dependencies. These do not block the production gate, but they
  // are printed so they are never silently ignored.
  let devOnly = [];
  try {
    const allReport = JSON.parse((await runAudit({ prod: false })).stdout);
    devOnly = devOnlyBlockingAdvisories(allReport, prodReport);
  } catch {
    console.warn(
      "notice: could not run the all-scope audit for dev-vs-prod visibility",
    );
  }

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const advisory of devOnly) {
    console.log(
      `notice (dev-only, non-blocking): ${advisory.severity} ${advisory.module} (${advisory.id}) — ${advisory.title}`,
    );
  }
  for (const line of ignored) console.log(`ignored: ${line}`);

  if (failures.length > 0) {
    console.error(
      `Production dependency vulnerability gate failed (${failures.length} unignored high/critical advisor${failures.length === 1 ? "y" : "ies"}):`,
    );
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(
      "Remediate by upgrading the parent dependency or adding a narrowly scoped pnpm override, or record a reviewed, time-bounded exception in scripts/vulnerability-allowlist.json.",
    );
    process.exitCode = 1;
    return;
  }

  const devNote =
    devOnly.length > 0
      ? ` ${devOnly.length} dev-only high/critical advisor${devOnly.length === 1 ? "y" : "ies"} reported (non-blocking).`
      : "";
  console.log(
    `No unignored high/critical production dependency vulnerabilities (${ignored.length} reviewed exception(s) active).${devNote}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
