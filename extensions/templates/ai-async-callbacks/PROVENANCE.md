# Provenance and source SBOM

The source is this pack directory at revision `extension-seed-packs-v0.1.0`. The
deterministic builder packages the canonical schema/example and text templates
with `@webhook-portal/extension-sdk` 0.1.0 at the fixed manifest timestamp.

The source SBOM lists the Apache-2.0 SDK as a direct build-only dependency.
There is no runtime dependency, model provider SDK, network client, or secret
resolver.

The public RFC 8032 development key signs local fixtures only. Release tooling
must reproduce the source digest and replace that signature with controlled
release signing.
