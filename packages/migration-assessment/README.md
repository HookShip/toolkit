# `@webhook-portal/migration-assessment`

Read-only, provider-neutral assessment for planning webhook migrations from
custom HTTP delivery, Svix, or Hookdeck. The package parses bounded JSON
exports, maps endpoint subscriptions to a canonical contract, compares an
adapter capability document and target policy, and renders deterministic JSON or
Markdown.

It **never connects to a provider, performs writes, handles signing material, or
claims to migrate anything automatically**.

## Install

```sh
pnpm add @webhook-portal/migration-assessment
```

Requires Node.js 22 or later.

## Import an inventory

```ts
import { readFile } from "node:fs/promises";

import {
  parseSvixInventoryExport,
  type MigrationInventory,
} from "@webhook-portal/migration-assessment/import";

const exportedJson = await readFile("svix.inventory.json");
const imported = parseSvixInventoryExport(exportedJson);

if (!imported.ok) {
  console.error(imported.diagnostics);
  process.exitCode = 1;
} else {
  const inventory: MigrationInventory = imported.inventory;
  // Pass the validated, secret-free inventory to assessment.
}
```

Provider helpers enforce the declared provider kind:

- `parseCustomHttpInventoryExport`
- `parseSvixInventoryExport`
- `parseHookdeckInventoryExport`
- `parseInventoryExportJson`

Only JSON text or UTF-8 bytes are accepted. Import is closed-schema and bounded
by byte, depth, object-property, total-value, endpoint, destination, and
subscription limits. Duplicate local IDs and duplicate provider IDs within the
same resource type are rejected. Provider IDs are otherwise opaque, so no Svix,
Hookdeck, or custom naming convention is assumed.

Credential-, authentication-, payload-, and header-shaped fields are rejected
before validation. Common credential value patterns are also rejected.
Destination URLs cannot contain userinfo, query strings, or fragments. The
schema stores signing **metadata** only: profile name, algorithms, header names,
and rotation capability—never key material.

## Assess a target

```ts
import { writeFile } from "node:fs/promises";

import {
  assessMigration,
  renderAssessmentJson,
  renderAssessmentMarkdown,
} from "@webhook-portal/migration-assessment";

const assessment = assessMigration({
  inventory,
  contract: canonicalContract,
  capabilities: targetAdapterCapabilities,
  targetPolicy: {
    allowedSigningAlgorithms: ["hmac-sha256"],
    endpointLimit: 500,
    requireHttps: true,
    requireRollbackExport: true,
    subscriptionLimitPerEndpoint: 100,
  },
});

await writeFile("assessment.json", renderAssessmentJson(assessment));
await writeFile("assessment.md", renderAssessmentMarkdown(assessment));
```

The deterministic result includes:

- a SHA-256 checksum of canonicalized inventory JSON and resource counts;
- endpoint/event mappings, including missing, unmapped, and ambiguous items;
- required adapter-operation parity and target policy/limit gaps;
- signing, HTTPS, retry, rate, retention, and observability gaps;
- fixed planning phases and explicit rollback prerequisites;
- sorted blockers and warnings;
- a transparent 100-point score with mapping (30), capability (25), security
  (20), operations (15), and rollback (10) components.

A numeric score never clears or hides blockers. `readiness.blocked` and
`readiness.statement` remain explicit, and all migration phases state that this
package is read-only.

JSON output uses stable key ordering. Markdown escapes control and formatting
characters. Both renderers enforce a configurable UTF-8 byte limit.

## Published artifacts and subpaths

- `@webhook-portal/migration-assessment/schema`
- `@webhook-portal/migration-assessment/schema.json`
- `@webhook-portal/migration-assessment/examples`
- `@webhook-portal/migration-assessment/examples/custom-http.json`
- `@webhook-portal/migration-assessment/examples/svix.json`
- `@webhook-portal/migration-assessment/examples/hookdeck.json`
- `@webhook-portal/migration-assessment/assessment`
- `@webhook-portal/migration-assessment/import`
- `@webhook-portal/migration-assessment/render`
- `@webhook-portal/migration-assessment/types`

## Security boundary

Treat the source provider export as untrusted. Do not add secrets to inventory
metadata to work around validation. Provisioning, secret creation/rotation, test
sends, cutover, and rollback execution belong in separately authorized workflows
with provider credentials and audit controls.

## License

Apache-2.0
