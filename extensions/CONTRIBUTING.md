# Contributing and review guide

## Data-only boundary

Extension resources must be inert data accepted by the extension SDK. Do not add
JavaScript, TypeScript, Wasm, shell code, provider SDKs, network clients,
dynamic expressions, remote schema references, or executable file modes.
Connector packs describe host configuration; they never perform a cloud call.

## Required source-pack contents

Each pack must include:

1. `manifest.source.json` with closed compatibility, permissions, resources,
   provenance, and source-SBOM declarations;
2. an `assets/` directory containing every and only declared bundle resource;
3. `README.md`, `CHANGELOG.md`, and `PROVENANCE.md`;
4. `conformance.json` naming the reusable suite and stable required cases;
5. fixture input and deterministic expected output.

JSON bundle assets use extension-specific filenames. The deterministic builder
parses and canonicalizes them before passing their bytes to the SDK; malformed
JSON fails the build. Human-authored source manifests and fixtures remain
formatted JSON outside `assets/`.

## Permission review

- Start from no permissions.
- Transform and policy requests must be covered by the SDK static analyzers.
- Remove redundant scopes and explain any wildcard.
- Data-only connector/template packs normally request no permissions.
- A cloud target documented for the host does not justify extension network or
  credential permissions.
- Secret references are identifiers only. Never commit credential values.

## Security and privacy review

Reviewers must verify:

- payload access is absent unless the pack's narrow purpose requires it;
- fixtures containing leakage sentinels never emit those values;
- headers and credential-shaped metadata are denied, redacted, or hashed as
  documented;
- schemas are closed and templates are contextually escaped by their consumer;
- retention text is advisory and cannot silently become enforcement authority;
- tampering, signature changes, and permission escalation fail closed.

## Signing and release

`test-fixtures/development-signing-key/` is public, deterministic test material.
It must never be added to a production trust policy. Development signatures only
make local conformance and reproducibility testable.

A release process must rebuild from reviewed source, compare deterministic
digests, replace development signatures with controlled release signatures,
publish provenance, and apply an independently reviewed trust policy.

## Validation

```sh
node extensions/scripts/build-sign.mjs --check
node --test extensions/test/seed-packs.test.mjs
pnpm check
```

The final command validates the repository but does not replace the dedicated
asset and conformance tests.

## Review decision

Approval means the source satisfies the data-only contract. It does not grant
production trust, support commitments, cloud permissions, or marketplace
publication. Public marketplace work remains deferred as documented in
[MARKETPLACE.md](MARKETPLACE.md).
