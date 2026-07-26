// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  advisoryEntries,
  blockingSeverities,
  devOnlyBlockingAdvisories,
  evaluateAudit,
} from "./check-vulnerabilities.mjs";

const now = new Date("2026-07-26T00:00:00.000Z");

function reportWith(...advisories) {
  const map = {};
  for (const advisory of advisories) map[advisory.id] = advisory;
  return { advisories: map, metadata: { vulnerabilities: {} } };
}

const highProd = {
  id: 111,
  github_advisory_id: "GHSA-aaaa-bbbb-cccc",
  module_name: "left-pad",
  severity: "high",
  title: "Example high",
  vulnerable_versions: "<1.0.0",
  patched_versions: ">=1.0.0",
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
};

test("blocking severities are exactly high and critical", () => {
  assert.deepEqual([...blockingSeverities].sort(), ["critical", "high"]);
});

test("advisoryEntries normalizes advisory fields and lowercases severity", () => {
  const [entry] = advisoryEntries(
    reportWith({ ...highProd, severity: "HIGH" }),
  );
  assert.equal(entry.id, "GHSA-aaaa-bbbb-cccc");
  assert.equal(entry.module, "left-pad");
  assert.equal(entry.severity, "high");
});

test("a high/critical advisory with no exception fails the gate", () => {
  const { failures, ignored } = evaluateAudit(
    reportWith(highProd),
    { ignore: [] },
    now,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /GHSA-aaaa-bbbb-cccc/);
  assert.deepEqual(ignored, []);
});

test("moderate and low advisories never block", () => {
  const { failures } = evaluateAudit(
    reportWith(
      {
        ...highProd,
        id: 1,
        github_advisory_id: "GHSA-mod",
        severity: "moderate",
      },
      { ...highProd, id: 2, github_advisory_id: "GHSA-low", severity: "low" },
    ),
    { ignore: [] },
    now,
  );
  assert.deepEqual(failures, []);
});

test("a valid, non-expired exception moves an advisory to ignored", () => {
  const { failures, ignored } = evaluateAudit(
    reportWith(highProd),
    {
      ignore: [
        {
          ghsa: "GHSA-aaaa-bbbb-cccc",
          reason: "no fix yet; mitigated by network policy",
          expires: "2026-12-31",
        },
      ],
    },
    now,
  );
  assert.deepEqual(failures, []);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0], /ignored until 2026-12-31/);
});

test("an expired exception fails the gate", () => {
  const { failures } = evaluateAudit(
    reportWith(highProd),
    {
      ignore: [
        { ghsa: "GHSA-aaaa-bbbb-cccc", reason: "stale", expires: "2020-01-01" },
      ],
    },
    now,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /expired on 2020-01-01/);
});

test("an exception without a valid expiry fails the gate", () => {
  const { failures } = evaluateAudit(
    reportWith(highProd),
    { ignore: [{ ghsa: "GHSA-aaaa-bbbb-cccc", reason: "oops" }] },
    now,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no valid ISO "expires" date/);
});

test("an unused exception is reported as a warning, not a failure", () => {
  const { failures, warnings } = evaluateAudit(
    reportWith(),
    {
      ignore: [
        { ghsa: "GHSA-gone", reason: "already fixed", expires: "2026-12-31" },
      ],
    },
    now,
  );
  assert.deepEqual(failures, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GHSA-gone/);
});

test("a clean audit report passes with no failures", () => {
  const { failures, ignored, warnings } = evaluateAudit(
    { advisories: {}, metadata: { vulnerabilities: {} } },
    { ignore: [] },
    now,
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(ignored, []);
  assert.deepEqual(warnings, []);
});

test("devOnlyBlockingAdvisories returns high/critical advisories absent from prod", () => {
  const devAdvisory = {
    ...highProd,
    id: 999,
    github_advisory_id: "GHSA-dev-only",
    module_name: "eslint-dep",
  };
  const allReport = reportWith(highProd, devAdvisory);
  const prodReport = reportWith(highProd);
  const devOnly = devOnlyBlockingAdvisories(allReport, prodReport);
  assert.equal(devOnly.length, 1);
  assert.equal(devOnly[0].id, "GHSA-dev-only");
  assert.equal(devOnly[0].module, "eslint-dep");
});

test("devOnlyBlockingAdvisories ignores non-blocking severities and is empty when prod == all", () => {
  const moderateDev = {
    ...highProd,
    id: 5,
    github_advisory_id: "GHSA-mod-dev",
    severity: "moderate",
  };
  assert.deepEqual(
    devOnlyBlockingAdvisories(
      reportWith(highProd, moderateDev),
      reportWith(highProd),
    ),
    [],
  );
  assert.deepEqual(
    devOnlyBlockingAdvisories(reportWith(highProd), reportWith(highProd)),
    [],
  );
});
