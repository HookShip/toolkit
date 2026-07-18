// SPDX-License-Identifier: Apache-2.0

const sourceInclude = ["src/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}"];
const serialVitestArgs = ["--maxWorkers=1", "--fileParallelism=false"];
const measuredBaselines = {
  "@webhook-portal/control-plane-api": {
    branches: 51.62,
    functions: 67.77,
    lines: 66.54,
    statements: 65.75,
  },
  "@webhook-portal/portal-web": {
    branches: 42.51,
    functions: 46.42,
    lines: 51.18,
    statements: 49.55,
  },
  "@webhook-portal/reference-server": {
    branches: 0,
    functions: 100,
    lines: 0,
    statements: 0,
  },
  "@webhook-portal/worker": {
    branches: 47.02,
    functions: 58.64,
    lines: 56.68,
    statements: 55.97,
  },
  "@webhook-portal/adapter-conformance": {
    branches: 76.14,
    functions: 96.36,
    lines: 84.94,
    statements: 85.12,
  },
  "@webhook-portal/adapter-generic-http": {
    branches: 70.13,
    functions: 93.37,
    lines: 81.47,
    statements: 81.44,
  },
  "@webhook-portal/adapter-hookdeck": {
    branches: 64.93,
    functions: 69.23,
    lines: 74.53,
    statements: 74.56,
  },
  "@webhook-portal/adapter-sdk": {
    branches: 77.76,
    functions: 87.32,
    lines: 82.33,
    statements: 82.19,
  },
  "@webhook-portal/adapter-svix": {
    branches: 71.59,
    functions: 83.49,
    lines: 82.22,
    statements: 82.22,
  },
  "@webhook-portal/billing": {
    branches: 50.38,
    functions: 64.1,
    lines: 62.03,
    statements: 62.07,
  },
  "@webhook-portal/canonical-model": {
    branches: 62.21,
    functions: 73.91,
    lines: 85.54,
    statements: 85.71,
  },
  "@webhook-portal/cli": {
    branches: 48.15,
    functions: 59.11,
    lines: 55.92,
    statements: 55.83,
  },
  "@webhook-portal/contract-core": {
    branches: 73.76,
    functions: 91.64,
    lines: 83.78,
    statements: 82.79,
  },
  "@webhook-portal/db": {
    branches: 18.49,
    functions: 22.17,
    lines: 27.66,
    statements: 27.59,
  },
  "@webhook-portal/extension-conformance": {
    branches: 80.23,
    functions: 91.07,
    lines: 94.69,
    statements: 94.84,
  },
  "@webhook-portal/extension-registry": {
    branches: 52.45,
    functions: 64.17,
    lines: 64,
    statements: 62.94,
  },
  "@webhook-portal/extension-sdk": {
    branches: 68.91,
    functions: 91.07,
    lines: 79.6,
    statements: 79.79,
  },
  "@webhook-portal/kms": {
    branches: 65.81,
    functions: 86.49,
    lines: 79.37,
    statements: 78.41,
  },
  "@webhook-portal/metering": {
    branches: 82.21,
    functions: 93.33,
    lines: 86.04,
    statements: 85.9,
  },
  "@webhook-portal/portal-components": {
    branches: 63.81,
    functions: 88.78,
    lines: 79,
    statements: 79.65,
  },
  "@webhook-portal/signing": {
    branches: 85.8,
    functions: 92.06,
    lines: 90.95,
    statements: 90.59,
  },
  "@webhook-portal/tenancy": {
    branches: 78.72,
    functions: 87.1,
    lines: 87.57,
    statements: 86.71,
  },
};

function thresholdsFor(baseline) {
  return Object.fromEntries(
    Object.entries(baseline).map(([metric, value]) => [
      metric,
      Math.floor(value),
    ]),
  );
}

function project(name, directory, options = {}) {
  const baseline = measuredBaselines[name];
  if (baseline === undefined) {
    throw new Error(`Missing measured coverage baseline for ${name}`);
  }
  return {
    name,
    directory,
    include: options.include ?? sourceInclude,
    vitestArgs: [...serialVitestArgs, ...(options.vitestArgs ?? [])],
    testExclusions: options.testExclusions ?? [],
    coverageException: options.coverageException,
    baseline,
    thresholds: {
      ...thresholdsFor(baseline),
      ...(options.thresholds ?? {}),
    },
  };
}

export const coverageExclude = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*.{test,spec}.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
  "**/coverage/**",
  "**/dist/**",
  "**/.next/**",
  "**/generated/**",
  "**/*.generated.*",
  "**/*.config.*",
  "**/node_modules/**",
  "**/*.d.ts",
];

export const coverageProjects = [
  project("@webhook-portal/control-plane-api", "apps/control-plane-api", {
    vitestArgs: ["--testTimeout=60000", "--hookTimeout=60000"],
  }),
  project("@webhook-portal/portal-web", "apps/portal-web", {
    include: [
      "app/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
      "src/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
    ],
  }),
  project("@webhook-portal/reference-server", "apps/reference-server", {
    coverageException:
      "This private app is a thin process/migration wrapper around the tested @webhook-portal/cli reference-server implementation. Its two entry-point scaffolds currently execute only in smoke and Compose checks, so their zero source baseline is explicit rather than hidden in the repository aggregate.",
  }),
  project("@webhook-portal/worker", "apps/worker"),
  project(
    "@webhook-portal/adapter-conformance",
    "packages/adapter-conformance",
  ),
  project(
    "@webhook-portal/adapter-generic-http",
    "packages/adapter-generic-http",
  ),
  project("@webhook-portal/adapter-hookdeck", "packages/adapter-hookdeck"),
  project("@webhook-portal/adapter-sdk", "packages/adapter-sdk"),
  project("@webhook-portal/adapter-svix", "packages/adapter-svix"),
  project("@webhook-portal/billing", "packages/billing"),
  project("@webhook-portal/canonical-model", "packages/canonical-model"),
  project("@webhook-portal/cli", "packages/cli"),
  project("@webhook-portal/contract-core", "packages/contract-core", {
    vitestArgs: [
      "--testNamePattern=^(?!.*indexes many anchors once under shared timing and work budgets).*$",
    ],
    testExclusions: [
      {
        test: "parser resource and object safety > indexes many anchors once under shared timing and work budgets",
        reason:
          "V8 instrumentation invalidates this test's two-second wall-clock budget; pnpm test still runs and gates it without instrumentation.",
      },
    ],
  }),
  project("@webhook-portal/db", "packages/db"),
  project(
    "@webhook-portal/extension-conformance",
    "packages/extension-conformance",
  ),
  project("@webhook-portal/extension-registry", "packages/extension-registry"),
  project("@webhook-portal/extension-sdk", "packages/extension-sdk"),
  project("@webhook-portal/kms", "packages/kms"),
  project("@webhook-portal/metering", "packages/metering"),
  project("@webhook-portal/portal-components", "packages/portal-components", {
    // The displayed 79.00% baseline is 78.995% before rounding.
    thresholds: { lines: 78 },
  }),
  project("@webhook-portal/signing", "packages/signing"),
  project("@webhook-portal/tenancy", "packages/tenancy"),
];

// A future app/package without a Vitest suite must be listed here with a
// concrete reason. An empty list means every current workspace is covered.
export const workspaceCoverageExclusions = [];

export const aggregateBaseline = {
  branches: 54.27,
  functions: 64.84,
  lines: 64.23,
  statements: 63.68,
};
export const aggregateThresholds = thresholdsFor(aggregateBaseline);

export const nonVitestCoverageScopes = [
  {
    directory: "extensions",
    reason:
      "The seed-pack Node test validates generated and signed artifacts rather than an instrumentable workspace runtime.",
  },
  {
    directory: "examples/managed-pilot",
    reason:
      "The pilot-kit Node test is an end-to-end artifact and operations harness.",
  },
  {
    directory: "infra/managed/pilot",
    reason:
      "Pilot tooling tests validate shell, Compose, and generated report contracts.",
  },
  {
    directory: "scripts",
    reason:
      "Repository policy scripts are exercised by Node's native test runner and operational checks.",
  },
];
