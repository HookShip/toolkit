// SPDX-License-Identifier: Apache-2.0

import type {
  SecretValue,
  AdapterCapabilityDocument,
  AdapterCommand,
  AdapterCommandResult,
  AdapterOperation,
  CanonicalDeliveryAttemptMetadata,
} from "@webhook-portal/adapter-sdk";

export class AdapterConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConformanceError";
  }
}

export interface ConformanceAdapter {
  readonly capabilityDocument: AdapterCapabilityDocument;
  execute(command: AdapterCommand): Promise<AdapterCommandResult>;
}

export interface ConformanceSideEffectProbe {
  read(): number | Promise<number>;
  reset(): void | Promise<void>;
}

export interface IdempotencyConformanceProbe {
  readonly command: () => AdapterCommand;
  readonly restart: () => ConformanceAdapter | Promise<ConformanceAdapter>;
  readonly retryCommand: () => AdapterCommand;
}

export interface DeadlineConformanceProbe {
  readonly command: () => AdapterCommand;
  readonly wasCancelled: () => boolean | Promise<boolean>;
}

export interface SendTestTimeoutConformanceProbe {
  readonly command: () => AdapterCommand;
  readonly retryCommand: () => AdapterCommand;
  readonly restart: () => ConformanceAdapter | Promise<ConformanceAdapter>;
}

export interface SecretConformanceProbe {
  readonly plaintext: string;
  readonly secret: SecretValue;
}

export interface CommandAuthenticationProbeResult {
  readonly concurrentConsumeSafe: boolean;
  readonly conflictingReplayRejected: boolean;
  readonly duplicateRejected: boolean;
  readonly expiredRejected: boolean;
  readonly forgedRejected: boolean;
  readonly receiverVerified: boolean;
  readonly storedResultReplayed: boolean;
  readonly wrongScopeRejected: boolean;
}

export interface AcknowledgementAuthenticationProbeResult {
  readonly expiredRejected: boolean;
  readonly forgedRejected: boolean;
  readonly modifiedRejected: boolean;
  readonly replayedRejected: boolean;
  readonly signedVerified: boolean;
  readonly unsignedRejected: boolean;
  readonly wrongKeyRejected: boolean;
  readonly wrongScopeRejected: boolean;
}

export interface MetadataIngestProbeResult {
  readonly forgedRejected: boolean;
  readonly identityDerived: boolean;
  readonly signedVerified: boolean;
  readonly wrongScopeRejected: boolean;
}

export interface ConformanceSecurityProbes {
  acknowledgementAuthentication(): Promise<AcknowledgementAuthenticationProbeResult>;
  commandAuthentication(): Promise<CommandAuthenticationProbeResult>;
  metadataIngest(): Promise<MetadataIngestProbeResult>;
}

export interface AdapterConformanceFixture {
  readonly adapter: ConformanceAdapter;
  readonly commands: Partial<Record<AdapterOperation, () => AdapterCommand>>;
  readonly deadline?: DeadlineConformanceProbe;
  readonly idempotency?: IdempotencyConformanceProbe;
  readonly metadata?: CanonicalDeliveryAttemptMetadata;
  readonly name?: string;
  readonly reset?: () => void | Promise<void>;
  readonly security?: ConformanceSecurityProbes;
  readonly secrets?: readonly SecretConformanceProbe[];
  readonly sendTestTimeout?: SendTestTimeoutConformanceProbe;
  readonly sideEffects?: ConformanceSideEffectProbe;
}

export type ConformanceCaseStatus = "failed" | "passed";

export interface ConformanceCaseResult {
  readonly durationMilliseconds: number;
  readonly message?: string;
  readonly name: string;
  readonly status: ConformanceCaseStatus;
}

export interface AdapterConformanceReport {
  readonly failed: number;
  readonly name: string;
  readonly passed: boolean;
  readonly results: readonly ConformanceCaseResult[];
  readonly skipped: 0;
  readonly succeeded: number;
}

export interface AdapterConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

export interface ConformanceTestRunner {
  describe(name: string, body: () => void): void;
  test(name: string, body: () => Promise<void> | void): void;
}
