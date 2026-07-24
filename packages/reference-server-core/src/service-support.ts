// SPDX-License-Identifier: Apache-2.0

import {
  resolveSafeDestination,
  type ValidatedDestination,
} from "@webhook-portal/adapter-generic-http";
import {
  fixtures,
  selectCanonicalEventVersion,
  type CanonicalContract,
  type CanonicalEventVersion,
  type JsonValue,
} from "@webhook-portal/contract-core";

import { referenceSha256 } from "./crypto.js";
import { PayloadCleanupConflictError } from "./repository-errors.js";
import { releaseMetadata } from "./release-metadata.js";
import type {
  PublishStatus,
  SecretVersionMetadata,
  SecretVersionRecord,
} from "./types.js";
import type { PublishServiceStatus } from "./service.js";

export class ReferenceApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Readonly<Record<string, JsonValue>> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = "ReferenceApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function publishServiceStatus(
  status: PublishStatus,
): PublishServiceStatus {
  if (status.status !== "completed") {
    return status;
  }
  return {
    ...status,
    release: releaseMetadata(status.release),
  };
}

export function sha256(value: Uint8Array | string): string {
  return referenceSha256(value);
}

export function payloadCleanupApiError(
  error: PayloadCleanupConflictError,
): ReferenceApiError {
  return new ReferenceApiError(
    409,
    error.state === "deleted"
      ? "PAYLOAD_REUPLOAD_REQUIRED"
      : "PAYLOAD_CLEANUP_IN_PROGRESS",
    error.state === "deleted"
      ? "The retained payload was deleted during reconciliation; retry to upload it again."
      : "The retained payload is being reconciled; retry after cleanup completes.",
    {
      retryable: true,
      cleanupState: error.state,
    },
  );
}

export function asSecretMetadata(
  record: SecretVersionRecord,
): SecretVersionMetadata {
  return {
    id: record.id,
    endpointId: record.endpointId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    state: record.state,
    ...(record.notBefore === undefined ? {} : { notBefore: record.notBefore }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

export function pickEvent(
  contract: CanonicalContract,
  eventType: string,
  publicVersion?: string,
): { readonly version: CanonicalEventVersion } {
  const selected = selectCanonicalEventVersion(
    contract,
    eventType,
    publicVersion,
  );
  if (selected.status === "version_required") {
    throw new ReferenceApiError(
      400,
      "EVENT_VERSION_REQUIRED",
      "The event has multiple public versions; provide an explicit version.",
      { availableVersions: selected.availableVersions },
    );
  }
  if (selected.status === "invalid_current_version") {
    throw new ReferenceApiError(
      422,
      "INVALID_CURRENT_EVENT_VERSION",
      "The release marks an invalid or ambiguous current event version.",
      { availableVersions: selected.availableVersions },
    );
  }
  if (selected.status !== "found") {
    throw new ReferenceApiError(
      404,
      "EVENT_NOT_FOUND",
      "The published event type was not found.",
      { availableVersions: selected.availableVersions },
    );
  }
  return { version: selected.version };
}

export function safeFixture(version: CanonicalEventVersion): JsonValue {
  const example = version.examples[0]?.value;
  if (example !== undefined) {
    return example;
  }
  const generated = fixtures(version.schema.value);
  if (generated.status !== "generated" || generated.value === undefined) {
    throw new ReferenceApiError(
      422,
      "FIXTURE_NOT_EXACT",
      "The event schema cannot produce an exact canonical fixture.",
      { generationStatus: generated.status },
    );
  }
  return generated.value;
}

export async function resolveDestination(
  url: string,
  allowLocalNetwork: boolean,
): Promise<ValidatedDestination> {
  return resolveSafeDestination(url, { allowLocalNetwork });
}
