// SPDX-License-Identifier: Apache-2.0

import type { SqlMigration } from "./migration.js";
import { migration001Initial } from "./001_initial.js";
import { migration002PersistenceHardening } from "./002_persistence_hardening.js";
import { migration003ReferenceRecovery } from "./003_reference_recovery.js";
import { migration004PayloadCleanupClaims } from "./004_payload_cleanup_claims.js";
import { migration005PayloadGenerations } from "./005_payload_generations.js";
import { migration006PersistenceDefinitive } from "./006_persistence_definitive.js";
import { migration007PayloadStorageIdentity } from "./007_payload_storage_identity.js";
import { migration008NamespaceBindingTimelineIdentity } from "./008_namespace_binding_timeline_identity.js";
import { migration009NamespaceDerivedBucket } from "./009_namespace_derived_bucket.js";
import { migration010PayloadStoreIdentity } from "./010_payload_store_identity.js";
import { migration011StoreDerivedBucket } from "./011_store_derived_bucket.js";

export const EXPECTED_REFERENCE_SCHEMA_VERSION = "011_store_derived_bucket";

export const REFERENCE_SERVER_MIGRATIONS: readonly SqlMigration[] =
  Object.freeze([
    migration001Initial,
    migration002PersistenceHardening,
    migration003ReferenceRecovery,
    migration004PayloadCleanupClaims,
    migration005PayloadGenerations,
    migration006PersistenceDefinitive,
    migration007PayloadStorageIdentity,
    migration008NamespaceBindingTimelineIdentity,
    migration009NamespaceDerivedBucket,
    migration010PayloadStoreIdentity,
    migration011StoreDerivedBucket,
  ]);
