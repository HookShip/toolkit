# Metadata protection baseline

This bounded policy is a metadata-only baseline. It requires event identity
metadata, emits classification findings, denies credential and embedded-payload
fields, redacts sensitive headers/containers, and deterministically hashes
selected correlation values.

Header paths assume the host has normalized names to lowercase. The pack never
reads the policy runtime's separate `payload` target; `/payload` and `/body`
refer only to payload-shaped fields incorrectly embedded inside metadata.

## Permission rationale

The manifest requests exact `metadataRead` paths used by the rules and exact
`metadataWrite` paths used by redact/hash operations. It requests no payload,
network, secret-reference, endpoint, subscription, audit, metric, or timeline
permission.

Deny rules deliberately run before matching redactions. The decision records
that prohibited data was supplied while returned metadata no longer contains the
fixture value.

## Retention recommendations are not authority

`retention-recommendations.data` maps `field_classified` findings to suggested
maximum windows. It declares `authority: false`; the DSL does not apply TTLs or
delete records. A host may display these recommendations, but only an
independently approved host policy can authorize retention or deletion.

## Compatibility

- Manifest: `1.0`
- Policy DSL: `1.0`
- Platform: `^0.1.0`
- Extension SDK: `^0.1.0`
- Runtime dependencies: none

## Fixtures and conformance

The fixture exercises require, classify, deny, redact, and hash behavior.
Expected output contains findings and sanitized metadata without the leakage
sentinel. `conformance.json` declares common, tamper, determinism,
least-permission, and advisory-retention checks.

Development signatures use a public test key and are not production trust.
