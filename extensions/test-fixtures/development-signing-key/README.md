# Deterministic development signing key

**NON-PRODUCTION TEST ASSET — NEVER TRUST OR DEPLOY THIS PRIVATE KEY.**

The key pair is the first RFC 8032 Ed25519 test vector encoded as PKCS#8/SPKI.
It is intentionally public and deterministic so bundle bytes, signatures, and
tamper tests are reproducible across machines.

Key ID: `webhook-portal-development-test-key-rfc8032-1`

This fixture establishes no publisher identity or production trust. Release
tooling must discard its signature and re-sign verified bundle digests with a
separately controlled release key.
