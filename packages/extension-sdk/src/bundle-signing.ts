// SPDX-License-Identifier: Apache-2.0

import { equalDigest } from "./canonical.js";
import { BundleError } from "./errors.js";
import {
  signBundleDigest,
  verifyBundleDigestSignatures,
  type ExtensionSigningKey,
  type SignatureTrustPolicy,
} from "./signatures.js";
import {
  computeExtensionBundleDigest,
  computeExtensionContentDigest,
  parseExtensionBundle,
} from "./bundle-core.js";
import type {
  BundleVerificationIssue,
  BundleVerificationResult,
  ExtensionBundle,
  ExtensionBundleLimits,
} from "./bundle-types.js";

function assertCurrentDigests(bundle: ExtensionBundle): void {
  const contentDigest = computeExtensionContentDigest(bundle.manifest);
  if (!equalDigest(contentDigest, bundle.manifest.integrity.contentDigest)) {
    throw new BundleError(
      "CONTENT_DIGEST_MISMATCH",
      "Manifest content digest is stale or invalid.",
    );
  }
  const bundleDigest = computeExtensionBundleDigest(bundle);
  if (!equalDigest(bundleDigest, bundle.manifest.integrity.bundleDigest)) {
    throw new BundleError(
      "BUNDLE_DIGEST_MISMATCH",
      "Bundle digest is stale or invalid.",
    );
  }
}

export function signExtensionBundle(
  value: ExtensionBundle,
  signer: ExtensionSigningKey,
): ExtensionBundle {
  const bundle = parseExtensionBundle(value);
  assertCurrentDigests(bundle);
  if (
    bundle.manifest.integrity.signatures.some(
      (signature) => signature.keyId === signer.keyId,
    )
  ) {
    throw new BundleError(
      "DUPLICATE_SIGNATURE",
      `Bundle already contains a signature from key ${signer.keyId}.`,
    );
  }
  const signature = signBundleDigest(
    bundle.manifest.integrity.bundleDigest,
    signer,
  );
  return parseExtensionBundle({
    ...bundle,
    manifest: {
      ...bundle.manifest,
      integrity: {
        ...bundle.manifest.integrity,
        signatures: [...bundle.manifest.integrity.signatures, signature],
      },
    },
  });
}

function issue(
  code: BundleVerificationIssue["code"],
  message: string,
): BundleVerificationIssue {
  return Object.freeze({ code, message });
}

export function verifyExtensionBundle(
  value: unknown,
  options: {
    readonly limits?: ExtensionBundleLimits;
    readonly trustPolicy: SignatureTrustPolicy;
  },
): BundleVerificationResult {
  let bundle: ExtensionBundle;
  try {
    bundle = parseExtensionBundle(value, options.limits);
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "Bundle validation failed.";
    return Object.freeze({
      ok: false,
      issues: Object.freeze([issue("MALFORMED_BUNDLE", message)]),
      signatureErrors: Object.freeze([]),
      validKeyIds: Object.freeze([]),
    });
  }
  const issues: BundleVerificationIssue[] = [];
  const contentDigest = computeExtensionContentDigest(bundle.manifest);
  if (!equalDigest(contentDigest, bundle.manifest.integrity.contentDigest)) {
    issues.push(
      issue(
        "CONTENT_DIGEST_MISMATCH",
        "Manifest content digest does not match canonical content.",
      ),
    );
  }
  const bundleDigest = computeExtensionBundleDigest(bundle);
  if (!equalDigest(bundleDigest, bundle.manifest.integrity.bundleDigest)) {
    issues.push(
      issue(
        "BUNDLE_DIGEST_MISMATCH",
        "Bundle digest does not match canonical bundle content.",
      ),
    );
  }
  const signatures = verifyBundleDigestSignatures(
    bundle.manifest.integrity.bundleDigest,
    bundle.manifest.integrity.signatures,
    options.trustPolicy,
  );
  if (!signatures.ok) {
    issues.push(
      issue(
        "SIGNATURE_VERIFICATION_FAILED",
        "Bundle did not satisfy the signature trust policy.",
      ),
    );
  }
  return Object.freeze({
    ok: issues.length === 0,
    bundle,
    issues: Object.freeze(issues),
    signatureErrors: signatures.errors,
    validKeyIds: signatures.validKeyIds,
  });
}
