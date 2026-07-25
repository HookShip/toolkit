// SPDX-License-Identifier: Apache-2.0

export {
  CANONICAL_METADATA_SCHEMA_VERSION,
  CANONICAL_METADATA_FIELDS,
  METADATA_DELIVERY_INPUT_FIELDS,
  METADATA_INGEST_SCHEMA_VERSION,
  METADATA_INGEST_SIGNATURE_ALGORITHM,
} from "./metadata-types.js";
export type {
  CanonicalDeliveryAttemptMetadata,
  CanonicalMetadataField,
  CanonicalMetadataRecord,
  DeliveryAttemptStatus,
  EventVersionProvenance,
  MetadataDeliveryAttemptInput,
  MetadataIdentity,
  MetadataInputValidationResult,
  MetadataValidationIssue,
  MetadataValidationResult,
} from "./metadata-types.js";
export { validateMetadataDeliveryAttemptInput } from "./metadata-validation.js";
export {
  assertCanonicalMetadataRecord,
  canonicalizeMetadataRecord,
  createDedupeKey,
  createDeliveryAttemptDedupeKey,
  deliveryAttemptDedupeKey,
  reduceDeliveryAttempt,
  reduceDeliveryAttemptMetadata,
  validateCanonicalMetadataRecord,
} from "./metadata-canonical.js";
export type { DeliveryAttemptReduction } from "./metadata-canonical.js";
export {
  createAuthenticatedMetadataIngestEnvelope,
  verifyAuthenticatedMetadataIngestEnvelope,
} from "./metadata-ingest.js";
export type {
  AuthenticatedMetadataIngestEnvelope,
  MetadataIngestEnvelopeContent,
  MetadataIngestEnvelopeOptions,
  MetadataIngestVerificationResult,
} from "./metadata-ingest.js";
