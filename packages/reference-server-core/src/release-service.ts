// SPDX-License-Identifier: Apache-2.0

import { diff, publishRequestFingerprint } from "@webhook-portal/contract-core";

import type { ReferenceServiceContext } from "./service-context.js";
import { ReferenceApiError, publishServiceStatus } from "./service-support.js";
import { RepositoryCommitUncertainError } from "./repository-errors.js";
import { releaseMetadata } from "./release-metadata.js";
import type { PublishRecoveryResult, PublishServiceStatus } from "./service.js";
import type {
  PublishCommandRecord,
  PublishStatus,
  ReleaseChangelog,
  ReleaseMetadata,
  ReleaseRecord,
} from "./types.js";

export class ReleaseService {
  readonly #ctx: ReferenceServiceContext;

  constructor(ctx: ReferenceServiceContext) {
    this.#ctx = ctx;
  }

  async publishRelease(
    importId: string,
    correlationId: string,
    overrideReason?: string,
    idempotencyKey?: string,
  ): Promise<ReleaseMetadata> {
    const trimmedReason = overrideReason?.trim();
    const reason =
      trimmedReason === undefined || trimmedReason.length === 0
        ? undefined
        : trimmedReason;
    if (reason !== undefined && reason.length > 500) {
      throw new ReferenceApiError(
        400,
        "OVERRIDE_REASON_TOO_LONG",
        "The override reason exceeds 500 characters.",
      );
    }
    const importRecord = await this.#ctx.repository.getContractImport(importId);
    if (importRecord === undefined) {
      throw new ReferenceApiError(
        404,
        "IMPORT_NOT_FOUND",
        "The contract import was not found.",
      );
    }
    if (
      importRecord.status !== "valid" ||
      importRecord.contract === undefined ||
      importRecord.canonicalExport === undefined
    ) {
      throw new ReferenceApiError(
        422,
        "IMPORT_NOT_PUBLISHABLE",
        "Only a fully valid contract import can be published.",
        { importStatus: importRecord.status },
      );
    }
    const requestFingerprint = publishRequestFingerprint(
      importRecord.contract.checksum.value,
      reason,
    );
    const publishIdempotencyKey =
      idempotencyKey ?? `implicit:${requestFingerprint}`;
    let outcome:
      | {
          readonly kind: "incompatible";
          readonly compatibility: "breaking" | "unknown";
          readonly changeCount: number;
        }
      | { readonly kind: "conflict" }
      | { readonly kind: "pending" }
      | { readonly kind: "published"; readonly release: ReleaseRecord };
    try {
      outcome = await this.#ctx.repository.transaction(async (repository) => {
        const active = await repository.lockReleaseState();
        const existing = await repository.getPublishCommand(
          publishIdempotencyKey,
        );
        if (existing !== undefined) {
          if (existing.requestFingerprint !== requestFingerprint) {
            return { kind: "conflict" as const };
          }
          if (
            existing.state !== "completed" ||
            existing.releaseId === undefined
          ) {
            return { kind: "pending" as const };
          }
          const release = await repository.getRelease(existing.releaseId);
          if (release === undefined) {
            throw new Error("A completed publish command has no release.");
          }
          return { kind: "published" as const, release };
        }

        const compatibility =
          active === undefined
            ? undefined
            : diff(active.contract, importRecord.contract!);
        const blocked =
          compatibility?.status === "breaking" ||
          compatibility?.status === "unknown";
        if (blocked && !reason) {
          await this.#ctx.audit(
            {
              action: "release.publish",
              resourceType: "contract_import",
              resourceId: importId,
              result: "denied",
              correlationId,
              details: { compatibility: compatibility.status },
            },
            repository,
          );
          return {
            kind: "incompatible" as const,
            compatibility: compatibility.status,
            changeCount: compatibility.changes.length,
          };
        }

        const changelog: ReleaseChangelog =
          compatibility === undefined
            ? { summary: "Initial publication", status: "initial", changes: [] }
            : {
                summary: compatibility.summary,
                status: compatibility.status,
                changes: compatibility.changes,
              };
        const timestamp = this.#ctx.nowIso();
        const command: PublishCommandRecord = {
          id: this.#ctx.idFactory(),
          idempotencyKey: publishIdempotencyKey,
          requestFingerprint,
          importId,
          state: "requested",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await repository.createPublishCommand(command);
        const release = await repository.publishRelease({
          id: this.#ctx.idFactory(),
          importRecord,
          changelog,
          createdAt: timestamp,
          ...(compatibility === undefined ? {} : { compatibility }),
          ...(reason === undefined ? {} : { overrideReason: reason }),
        });
        await repository.completePublishCommand(
          command.id,
          release.id,
          active?.id,
          timestamp,
        );
        await this.#ctx.audit(
          {
            action: "release.publish",
            resourceType: "release",
            resourceId: release.id,
            result: "success",
            correlationId,
            details: {
              checksum: release.checksum,
              compatibility: changelog.status,
              overrideUsed: reason !== undefined,
              predecessorReleaseId: active?.id ?? null,
            },
          },
          repository,
        );
        await this.#ctx.outbox(
          {
            topic: "release.published",
            aggregateType: "release",
            aggregateId: release.id,
            correlationId,
            payload: {
              importId,
              predecessorReleaseId: active?.id ?? null,
              checksum: release.checksum,
            },
          },
          repository,
        );
        return { kind: "published" as const, release };
      });
    } catch (error) {
      if (!(error instanceof RepositoryCommitUncertainError)) {
        throw error;
      }
      const recovery = await this.recoverPublishStatus(
        publishIdempotencyKey,
        requestFingerprint,
      );
      if (recovery.status === "completed") {
        return recovery.release;
      }
      if (recovery.status === "conflict") {
        throw new ReferenceApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "The publish idempotency key was already used for another request.",
        );
      }
      if (recovery.status === "pending") {
        throw new ReferenceApiError(
          409,
          "PUBLISH_PENDING",
          "The original publish request is still pending.",
          {
            idempotencyKey: publishIdempotencyKey,
            publishStatus: "pending",
          },
        );
      }
      if (recovery.status === "not_found") {
        throw new ReferenceApiError(
          503,
          "PUBLISH_NOT_COMMITTED",
          "The publish was not observed after commit acknowledgement was lost.",
          {
            idempotencyKey: publishIdempotencyKey,
            publishStatus: "not_found",
            safeToRetry: true,
          },
        );
      }
      throw new ReferenceApiError(
        503,
        "PUBLISH_OUTCOME_UNKNOWN",
        "The publish outcome could not be reconciled.",
        {
          idempotencyKey: publishIdempotencyKey,
          publishStatus: recovery.status,
          safeToRetry: false,
        },
      );
    }

    if (outcome.kind === "conflict") {
      throw new ReferenceApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The publish idempotency key was already used for another request.",
      );
    }
    if (outcome.kind === "pending") {
      throw new ReferenceApiError(
        409,
        "PUBLISH_PENDING",
        "The original publish request is still pending.",
      );
    }
    if (outcome.kind === "incompatible") {
      throw new ReferenceApiError(
        409,
        "PUBLISH_INCOMPATIBLE",
        "Breaking or unknown compatibility changes require an explicit override reason.",
        {
          compatibility: outcome.compatibility,
          changeCount: outcome.changeCount,
        },
      );
    }
    return releaseMetadata(outcome.release);
  }

  async getPublishStatus(
    idempotencyKey: string,
  ): Promise<PublishServiceStatus> {
    return publishServiceStatus(
      await this.#ctx.repository.getPublishStatus(idempotencyKey),
    );
  }

  async recoverPublishStatus(
    idempotencyKey: string,
    expectedFingerprint?: string,
  ): Promise<PublishRecoveryResult> {
    let status: PublishStatus;
    try {
      status = await this.#ctx.repository.recoverPublishStatus(idempotencyKey);
    } catch {
      return {
        status: "unknown",
        idempotencyKey,
        ...(expectedFingerprint === undefined
          ? {}
          : { requestFingerprint: expectedFingerprint }),
      };
    }
    if (
      expectedFingerprint !== undefined &&
      status.status !== "not_found" &&
      status.command.requestFingerprint !== expectedFingerprint
    ) {
      return {
        status: "conflict",
        idempotencyKey,
        expectedFingerprint,
        actualFingerprint: status.command.requestFingerprint,
      };
    }
    return publishServiceStatus(status);
  }
}
