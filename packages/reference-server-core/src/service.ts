// SPDX-License-Identifier: Apache-2.0

import type {
  HttpTransport,
  ValidatedDestination,
} from "@webhook-portal/adapter-generic-http";
import type {
  AuthenticatedMetadataIngestEnvelope,
  MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";
import type {
  VerificationResult,
  WebhookHeadersInput,
} from "@webhook-portal/signing";

import type { SecretCipher } from "./crypto.js";
import { ContractService } from "./contract-service.js";
import { EndpointService } from "./endpoint-service.js";
import { MetadataService } from "./metadata-service.js";
import type { PayloadStorage } from "./payload-storage.js";
import { ReleaseService } from "./release-service.js";
import { SecretService } from "./secret-service.js";
import { ReferenceServiceContext } from "./service-context.js";
import { TestDispatchService } from "./test-dispatch-service.js";
import type {
  AuditRecord,
  ContractImportRecord,
  EndpointRecord,
  MetadataIngestSummary,
  PublishCommandRecord,
  ReferenceRepository,
  ReferenceServerConfig,
  ReleaseMetadata,
  SecretVersionMetadata,
  TestCommandRecord,
  TimelineFilters,
  TimelinePage,
} from "./types.js";

export { ReferenceApiError } from "./service-support.js";

export interface ReferenceServiceOptions {
  readonly repository: ReferenceRepository;
  readonly cipher: SecretCipher;
  readonly config: ReferenceServerConfig;
  readonly payloadStorage: PayloadStorage;
  readonly transport?: HttpTransport;
  readonly clock?: () => number | Date;
  readonly idFactory?: () => string;
}

export interface ImportContractInput {
  readonly source: string;
  readonly sourceMediaType: "application/json" | "application/yaml";
  readonly sourceUri?: string;
  readonly correlationId: string;
}

export interface CreateEndpointServiceInput {
  readonly url: string;
  readonly description?: string;
  readonly allowLocalNetwork: boolean;
  readonly correlationId: string;
}

export interface UpdateEndpointServiceInput {
  readonly url?: string;
  readonly description?: string | null;
  readonly allowLocalNetwork?: boolean;
  readonly state?: "active" | "deleted" | "paused";
  readonly correlationId: string;
}

export interface SendTestServiceInput {
  readonly endpointId: string;
  readonly eventType: string;
  readonly eventVersion?: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface CreateSecretResult {
  readonly secret: string;
  readonly metadata: SecretVersionMetadata;
}

export type PublishServiceStatus =
  | {
      readonly status: "not_found";
      readonly idempotencyKey: string;
    }
  | {
      readonly status: "pending";
      readonly idempotencyKey: string;
      readonly command: PublishCommandRecord;
    }
  | {
      readonly status: "completed";
      readonly idempotencyKey: string;
      readonly command: PublishCommandRecord;
      readonly release: ReleaseMetadata;
    }
  | {
      readonly status: "inconsistent";
      readonly idempotencyKey: string;
      readonly command: PublishCommandRecord;
      readonly reason: "release_not_found";
    };

export type PublishRecoveryResult =
  | PublishServiceStatus
  | {
      readonly status: "conflict";
      readonly idempotencyKey: string;
      readonly expectedFingerprint: string;
      readonly actualFingerprint: string;
    }
  | {
      readonly status: "unknown";
      readonly idempotencyKey: string;
      readonly requestFingerprint?: string;
    };

export { releaseMetadata } from "./release-metadata.js";

export class ReferenceService {
  readonly #ctx: ReferenceServiceContext;
  readonly #contract: ContractService;
  readonly #release: ReleaseService;
  readonly #endpoint: EndpointService;
  readonly #secret: SecretService;
  readonly #testDispatch: TestDispatchService;
  readonly #metadata: MetadataService;

  constructor(options: ReferenceServiceOptions) {
    this.#ctx = new ReferenceServiceContext(options);
    this.#contract = new ContractService(this.#ctx);
    this.#release = new ReleaseService(this.#ctx);
    this.#endpoint = new EndpointService(this.#ctx);
    this.#secret = new SecretService(this.#ctx);
    this.#testDispatch = new TestDispatchService(this.#ctx);
    this.#metadata = new MetadataService(this.#ctx);
  }

  importContract(input: ImportContractInput): Promise<ContractImportRecord> {
    return this.#contract.importContract(input);
  }

  publishRelease(
    importId: string,
    correlationId: string,
    overrideReason?: string,
    idempotencyKey?: string,
  ): Promise<ReleaseMetadata> {
    return this.#release.publishRelease(
      importId,
      correlationId,
      overrideReason,
      idempotencyKey,
    );
  }

  getPublishStatus(idempotencyKey: string): Promise<PublishServiceStatus> {
    return this.#release.getPublishStatus(idempotencyKey);
  }

  recoverPublishStatus(
    idempotencyKey: string,
    expectedFingerprint?: string,
  ): Promise<PublishRecoveryResult> {
    return this.#release.recoverPublishStatus(
      idempotencyKey,
      expectedFingerprint,
    );
  }

  validateEndpointDestination(
    url: string,
    requestedLocalOptIn: boolean,
  ): Promise<ValidatedDestination> {
    return this.#ctx.validateEndpointDestination(url, requestedLocalOptIn);
  }

  createEndpoint(input: CreateEndpointServiceInput): Promise<EndpointRecord> {
    return this.#endpoint.createEndpoint(input);
  }

  updateEndpoint(
    id: string,
    input: UpdateEndpointServiceInput,
  ): Promise<EndpointRecord> {
    return this.#endpoint.updateEndpoint(id, input);
  }

  setSubscriptions(
    endpointId: string,
    eventTypes: readonly string[],
    correlationId: string,
  ) {
    return this.#endpoint.setSubscriptions(
      endpointId,
      eventTypes,
      correlationId,
    );
  }

  verifyEndpointWebhook(
    endpointId: string,
    body: Uint8Array,
    headers: WebhookHeadersInput,
  ): Promise<VerificationResult> {
    return this.#endpoint.verifyEndpointWebhook(endpointId, body, headers);
  }

  createSecret(
    endpointId: string,
    correlationId: string,
  ): Promise<CreateSecretResult> {
    return this.#secret.createSecret(endpointId, correlationId);
  }

  rotateSecret(
    endpointId: string,
    overlapSeconds: number,
    correlationId: string,
  ): Promise<CreateSecretResult> {
    return this.#secret.rotateSecret(endpointId, overlapSeconds, correlationId);
  }

  revokeSecret(
    endpointId: string,
    secretId: string,
    correlationId: string,
  ): Promise<SecretVersionMetadata> {
    return this.#secret.revokeSecret(endpointId, secretId, correlationId);
  }

  listSecretMetadata(
    endpointId: string,
  ): Promise<readonly SecretVersionMetadata[]> {
    return this.#secret.listSecretMetadata(endpointId);
  }

  sendTest(input: SendTestServiceInput): Promise<TestCommandRecord> {
    return this.#testDispatch.sendTest(input);
  }

  createMetadataEnvelope(
    records: readonly MetadataDeliveryAttemptInput[],
    batchId: string,
  ): AuthenticatedMetadataIngestEnvelope {
    return this.#metadata.createMetadataEnvelope(records, batchId);
  }

  ingestMetadataEnvelope(
    envelope: unknown,
    correlationId: string,
  ): Promise<MetadataIngestSummary> {
    return this.#metadata.ingestMetadataEnvelope(envelope, correlationId);
  }

  listTimeline(
    filters: TimelineFilters,
    correlationId?: string,
  ): Promise<TimelinePage> {
    return this.#metadata.listTimeline(filters, correlationId);
  }

  listAudit(
    limit: number,
    correlationId?: string,
  ): Promise<readonly AuditRecord[]> {
    return this.#metadata.listAudit(limit, correlationId);
  }

  get repository(): ReferenceRepository {
    return this.#ctx.repository;
  }
}
