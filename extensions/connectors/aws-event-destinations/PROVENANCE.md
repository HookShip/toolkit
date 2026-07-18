# Provenance and source SBOM

The source is this pack directory at revision `extension-seed-packs-v0.1.0`.
`extensions/scripts/build-sign.mjs` packages the declared `assets/` files with
`@webhook-portal/extension-sdk` 0.1.0 using a fixed build timestamp and
canonical serialization.

The manifest SBOM lists the SDK as a direct, Apache-2.0, build-only dependency.
The finished pack has no runtime dependency, provider SDK, or network client.

Local bundles use the public RFC 8032 development key fixture solely for
reproducibility and tamper tests. A release must verify the same source digest
and replace that signature with controlled release signing.
