// SPDX-License-Identifier: Apache-2.0

// Curated public surface for `@webhook-portal/reference-server-core` (also
// re-exported through the deprecated `@webhook-portal/cli/reference-server`
// subpath). Cohesive modules are re-exported wholesale; modules that also carry
// package-internal utilities expose only their public members. Generic helpers
// used only across reference-server modules (code-unit/number comparators,
// constant-time token comparison, SHA-256 helper, loopback host check) are
// intentionally NOT part of the public surface — import them from their module
// directly internally.

// The publish idempotency fingerprint is owned by @webhook-portal/contract-core
// so the CLI publish command shares it without importing this server runtime.
export { publishRequestFingerprint } from "@webhook-portal/contract-core";
export {
  AesGcmSecretCipher,
  metadataTimelineIdentityKey,
  type SecretCipher,
} from "./crypto.js";
export * from "./cursor.js";
export * from "./memory-repository.js";
export * from "./migrations.js";
export * from "./payload-storage.js";
export * from "./postgres-repository.js";
export * from "./repository-errors.js";
export * from "./release-metadata.js";
export {
  migrateReferenceServerFromEnv,
  payloadStorageFromEnv,
  referenceServerConfigFromEnv,
  runReferenceServerProcess,
  startReferenceServerFromEnv,
  type RunningReferenceServer,
  type StartReferenceServerOptions,
} from "./runtime.js";
export * from "./server.js";
export * from "./service.js";
export * from "./types.js";
