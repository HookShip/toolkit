# First-party extension source packs

This directory contains reviewed, **data-only** source packs for the
`@webhook-portal/extension-sdk`. They contain schemas, declarative DSL programs,
templates, documentation, and test fixtures only. They do not contain provider
SDKs, network clients, JavaScript/Wasm entry points, or installation authority.

## Catalog

| Kind      | Pack                                                                   | Purpose                                                                   |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Connector | [AWS event destinations](connectors/aws-event-destinations/)           | EventBridge/SQS-style host-managed destination configuration              |
| Transform | [Canonical metadata envelope](transforms/canonical-metadata-envelope/) | Standard Webhooks/CloudEvents-style metadata mapping without payload      |
| Policy    | [Metadata protection baseline](policies/metadata-protection-baseline/) | Metadata credential/header/payload-field findings and advisory retention  |
| Template  | [AI asynchronous callbacks](templates/ai-async-callbacks/)             | Illustrative callback contracts, examples, portal copy, and configuration |

Every pack includes a source manifest, bundled resources, compatibility and
permission rationale, fixtures with expected output, changelog, source/SBOM
description, and a machine-readable conformance declaration.

## Build and test

```sh
node extensions/scripts/build-sign.mjs --check
node --test extensions/test/seed-packs.test.mjs
```

Running the build script without `--check` writes canonical bundles to
`extensions/dist/`. That directory is ignored because release tooling must
rebuild and re-sign from source.

The committed signing key is an RFC 8032-derived deterministic **development
test fixture**. Its signatures prove reproducibility and tamper detection only.
They are not production trust, publisher identity, endorsement, or marketplace
approval. Production releases must use separately controlled release keys and an
explicit trust policy.

## Marketplace status

Public marketplace publication, discovery, remote installation, and production
publisher trust are explicitly **deferred**. See
[MARKETPLACE.md](MARKETPLACE.md). These source packs may be reviewed and tested
locally, but no catalog entry here implies public availability or production
support.

Contribution and review requirements are in [CONTRIBUTING.md](CONTRIBUTING.md).
