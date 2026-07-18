# Provenance and source SBOM

The source is this pack directory at revision `extension-seed-packs-v0.1.0`. The
deterministic builder packages the canonical policy and recommendation data with
`@webhook-portal/extension-sdk` 0.1.0 at the fixed manifest timestamp.

The source SBOM lists the Apache-2.0 SDK as the sole direct build dependency.
The policy has no runtime dependency or retention enforcement mechanism.

Local signatures use intentionally public RFC 8032 test material. Release
tooling must reproduce the source digest and replace the development signature
with controlled release signing.
