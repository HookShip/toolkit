# `@webhook-portal/extension-sdk`

Production-grade, Apache-2.0 foundation for **data-only** Webhook Portal
extensions. It deliberately has no module loader, JavaScript/Wasm entry point,
`eval`, provider-call runtime, network client, clock, or random source.

Version: `0.1.0` · Runtime: Node.js 22+ · Dependencies: none

## Extension model

The `1.0` closed manifest supports four kinds:

- `connector`: configuration schema and text template assets only;
- `transform`: a bounded declarative transform program;
- `policy`: a bounded declarative policy program;
- `template`: named text assets only.

Every manifest binds identity, publisher, semver, platform/SDK compatibility,
dependencies, conflicts, capabilities, requested permissions, resources, entry
declarations, source/build provenance, SBOM-like dependency metadata, content
digest, bundle digest, and Ed25519 signatures. Unknown fields are rejected at
every closed object boundary.

## Quick start

```ts
import { generateKeyPairSync } from "node:crypto";

import {
  EXAMPLE_TRANSFORM_ASSET,
  createExampleTransformManifest,
} from "@webhook-portal/extension-sdk/examples";
import {
  createExtensionBundle,
  signExtensionBundle,
  verifyExtensionBundle,
} from "@webhook-portal/extension-sdk/bundle";

const unsigned = createExtensionBundle({
  manifest: createExampleTransformManifest(),
  assets: [
    {
      path: "transform.json",
      mediaType: "application/json",
      content: EXAMPLE_TRANSFORM_ASSET,
    },
  ],
});

const keys = generateKeyPairSync("ed25519");
const signed = signExtensionBundle(unsigned, {
  keyId: "publisher-2026-07",
  privateKey: keys.privateKey,
});

const verified = verifyExtensionBundle(signed, {
  trustPolicy: {
    minimumSignatures: 1,
    keys: [
      {
        keyId: "publisher-2026-07",
        publicKey: keys.publicKey,
        status: "active",
      },
    ],
  },
});

if (!verified.ok) throw new Error("Untrusted extension");
```

Private keys are inputs to signing only and are never placed in a manifest,
bundle, verification result, or lock. Extension configuration refers to
secret-reference IDs; materialization remains a host responsibility.

## Public entry points

| Entry point     | Main APIs                                                   |
| --------------- | ----------------------------------------------------------- |
| package root    | Complete public API                                         |
| `/manifest`     | `parseExtensionManifest`, `normalizeExtensionManifestDraft` |
| `/canonical`    | RFC 8785-style canonical JSON, Unicode checks, SHA-256      |
| `/bundle`       | create/parse/serialize/pack/sign/verify data-only bundles   |
| `/errors`       | Stable typed SDK errors and codes                           |
| `/json-pointer` | Safe JSON Pointer normalization and access helpers          |
| `/signatures`   | Ed25519 signing and trust-policy verification               |
| `/permissions`  | scope normalization, subset checks, digest-bound grants     |
| `/transform`    | closed transform parser, permission analysis, evaluator     |
| `/policy`       | closed policy parser, permission analysis, evaluator        |
| `/packs`        | verified connector/template/program data loaders            |
| `/semver`       | bounded semver and range parser                             |
| `/resolver`     | deterministic dependency graph and install decisions        |
| `/lock`         | canonical installation locks and checksums                  |
| `/examples`     | deterministic example manifest and DSL assets               |

## Permissions

Permissions are empty by default. Scopes cover:

- metadata read/write JSON Pointer fields;
- endpoint and subscription actions;
- HTTPS outbound hostname allowlists;
- secret-reference IDs (never values);
- timeline, audit, and metric actions;
- payload read/write JSON Pointer fields.

`createInstallationPermissionGrant` rejects grants beyond the manifest request
and binds a grant to both extension ID and immutable bundle digest.
`authorizePermission` rejects identity/digest mismatches and delegated requests
to prevent confused-deputy reuse.

```ts
import {
  analyzeTransformPermissions,
  runTransform,
} from "@webhook-portal/extension-sdk/transform";

const permissions = analyzeTransformPermissions(program);
const output = runTransform(program, payload, { permissions });
```

Calling a transform or policy without all statically required scopes fails
closed. Payload access is never implicit.

## Bundle and trust guarantees

- canonical UTF-8 JSON only; no archive or compression layer;
- at most 256 assets, 1 MiB each, and 8 MiB total asset bytes;
- per-file path, media type, size, and SHA-256 digest;
- traversal, case-colliding paths, symlinks, executable bits/suffixes, binary
  bytes, unlisted files, and recognized embedded secret fields are rejected;
- SHA-256 content and bundle digests;
- Ed25519 signatures with key IDs, thresholds, required keys, validity windows,
  active/retired/revoked states, and overlap rotation;
- stable verification codes rather than an ambiguous boolean alone.

`packExtensionDirectory` uses `lstat` and never follows symlinks.

## Declarative runtimes

Transform operations are limited to `select`, `rename`, `drop`, constant `set`,
`coalesce`, `map-enum`, and placeholder `format`. Policy rules are limited to
`require`, `deny`, `redact`, deterministic SHA-256 `hash`, and `classify`.

Both runtimes enforce closed fields, safe JSON Pointers, prototype-pollution
guards, operation/rule counts, nesting depth, evaluation steps, output bytes,
and string bounds. They expose no regex, script, network, file, environment,
time, locale, or randomness primitive.

Connector and template packs return configuration/schema/template data only.
There is intentionally no connector `execute()` API.

## Compatibility and installation

The bounded semver subset supports exact versions, comparators, `^`, `~`,
wildcards, conjunction, and `||`. The deterministic resolver performs bounded
backtracking, rejects cycles/conflicts, honors pins, and reports install, keep,
replace, upgrade, rollback, and removal decisions.

Installation locks include resolved digests, dependency edges, provenance
digests, permission grants, decisions, and a canonical checksum.

## Security limitations

- Signature verification establishes integrity and configured publisher trust;
  it does not establish that a publisher is benevolent.
- Host allowlists operate on normalized HTTPS hostnames. Production hosts must
  additionally enforce DNS-resolution/IP egress policy to prevent rebinding and
  private-network access.
- Secret-pattern detection is defense in depth, not a general secret scanner.
  Never place credentials in extension assets.
- Text/Markdown/template output is untrusted data. Consumers must contextually
  escape it before HTML, shell, SQL, or URL use.
- JSON Schema support is intentionally a closed, local subset with no `$ref`,
  regex pattern, remote vocabulary, or custom keyword execution.
- Dependency resolution assumes candidate manifests/bundles were verified before
  being supplied.
- The SDK does not install extensions, persist trust policy, resolve DNS,
  materialize secrets, or execute provider calls.
