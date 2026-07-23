// SPDX-License-Identifier: Apache-2.0

import { sha256Hex } from "@webhook-portal/canonical-model";

/**
 * Deterministic fingerprint binding a canonical contract checksum and an
 * optional publish override reason. It is the shared idempotency contract
 * between the CLI `publish` command (which computes it to send) and the
 * reference server (which recomputes it to detect replays and conflicts), so
 * both agree byte-for-byte without the CLI importing the server runtime.
 *
 * The encoding is `sha256_hex(JSON.stringify({ canonicalChecksum, overrideReason }))`
 * with a fixed key order and a `null` sentinel for an absent reason; do not
 * change it without versioning the publish idempotency protocol.
 */
export function publishRequestFingerprint(
  canonicalChecksum: string,
  overrideReason?: string,
): string {
  return sha256Hex(
    JSON.stringify({
      canonicalChecksum,
      overrideReason: overrideReason ?? null,
    }),
  );
}
