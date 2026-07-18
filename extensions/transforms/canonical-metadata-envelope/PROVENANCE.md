# Provenance and source SBOM

The source is this pack directory at revision `extension-seed-packs-v0.1.0`. The
deterministic builder packages the canonical DSL asset with
`@webhook-portal/extension-sdk` 0.1.0 at the fixed timestamp in the manifest.

The source SBOM records the Apache-2.0 SDK as a direct build dependency. The
transform has no runtime dependencies and exposes no executable, network, clock,
random, file, or environment primitive.

The committed RFC 8032 signing key is public development test material. Release
tooling must reproduce the digest from source and apply a controlled release
signature.
