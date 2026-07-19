# Deterministic development signing identity

**NON-PRODUCTION TEST IDENTITY — NEVER TRUST IT IN PRODUCTION.**

The public key is the first RFC 8032 Ed25519 test vector encoded as SPKI.
`extensions/scripts/build-sign.mjs` derives the matching private key at runtime
from the published RFC seed and public-key constants. No private-key file is
stored in the repository.

Key ID: `webhook-portal-development-test-key-rfc8032-1`

This fixture establishes no publisher identity or production trust. Release
tooling must discard its signature and re-sign verified bundle digests with a
separately controlled release key.
