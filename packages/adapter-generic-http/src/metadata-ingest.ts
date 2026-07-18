// SPDX-License-Identifier: Apache-2.0

import {
  verifyAuthenticatedMetadataIngestEnvelope,
  type MetadataIdentity,
  type MetadataIngestVerificationResult,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

export interface MetadataIngestVerifierConfig {
  readonly clock?: () => number;
  readonly credential: ScopedCredential;
  readonly identity: MetadataIdentity;
  readonly maximumClockSkewMilliseconds?: number;
  readonly maximumLifetimeMilliseconds?: number;
}

/**
 * Verifies inbound, connection-authenticated metadata without making an
 * outbound control API call or requiring a control base URL.
 */
export class MetadataIngestVerifier {
  readonly #clock: () => number;
  readonly #credential: ScopedCredential;
  readonly #identity: MetadataIdentity;
  readonly #maximumClockSkewMilliseconds: number | undefined;
  readonly #maximumLifetimeMilliseconds: number | undefined;

  constructor(config: MetadataIngestVerifierConfig) {
    this.#clock = config.clock ?? Date.now;
    this.#credential = config.credential;
    this.#identity = Object.freeze({ ...config.identity });
    this.#maximumClockSkewMilliseconds = config.maximumClockSkewMilliseconds;
    this.#maximumLifetimeMilliseconds = config.maximumLifetimeMilliseconds;
  }

  verify(value: unknown): MetadataIngestVerificationResult {
    return verifyAuthenticatedMetadataIngestEnvelope(
      value,
      this.#credential,
      this.#identity,
      {
        now: this.#clock(),
        ...(this.#maximumClockSkewMilliseconds === undefined
          ? {}
          : {
              maximumClockSkewMilliseconds: this.#maximumClockSkewMilliseconds,
            }),
        ...(this.#maximumLifetimeMilliseconds === undefined
          ? {}
          : {
              maximumLifetimeMilliseconds: this.#maximumLifetimeMilliseconds,
            }),
      },
    );
  }
}

export function createMetadataIngestVerifier(
  config: MetadataIngestVerifierConfig,
): MetadataIngestVerifier {
  return new MetadataIngestVerifier(config);
}
