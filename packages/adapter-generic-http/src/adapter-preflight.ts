// SPDX-License-Identifier: Apache-2.0

import {
  checkCredentialScope,
  computeAdapterCommandFingerprint,
  failureResult,
  hasSameSecretMaterial,
  isDeadlineError,
  isSideEffectingOperation,
  unsupportedResult,
  validateIdempotencyKey,
  type AdapterCapability,
  type AdapterCapabilityDocument,
  type AdapterCommand,
  type AdapterOperation,
  type AdapterResultFor,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

import {
  type GenericHttpRoute,
  type PreflightOutcome,
} from "./adapter-types.js";
import { commandProviderReferencesAreValid } from "./adapter-request.js";
import { unknownForOperation } from "./adapter-response.js";
import { operationSet } from "./adapter-validation.js";
import {
  withIdempotencyStoreDeadline,
  type IdempotencyStore,
} from "./idempotency.js";

interface GenericHttpPreflightContext {
  readonly baseUrl: URL;
  readonly capabilityDocument: AdapterCapabilityDocument;
  readonly clock: () => number;
  readonly connectionId: string;
  readonly idempotencyStore: IdempotencyStore | undefined;
  readonly responseCredential: ScopedCredential | undefined;
  readonly routes: Readonly<
    Partial<Record<AdapterOperation, GenericHttpRoute>>
  >;
}

type PreflightRejection<TCommand extends AdapterCommand> = {
  readonly ok: false;
  readonly result: AdapterResultFor<TCommand>;
};

type CredentialPreflight<TCommand extends AdapterCommand> =
  | PreflightRejection<TCommand>
  | {
      readonly ok: true;
      readonly credential: ScopedCredential;
    };

type SideEffectingPreflight<TCommand extends AdapterCommand> =
  | PreflightRejection<TCommand>
  | {
      readonly ok: true;
      readonly localFingerprint: string | undefined;
      readonly localScopeReason: string | undefined;
    };

type CapabilityRoutePreflight<TCommand extends AdapterCommand> =
  | PreflightRejection<TCommand>
  | {
      readonly ok: true;
      readonly capability: AdapterCapability & {
        readonly status: "degraded" | "supported";
      };
      readonly route: GenericHttpRoute;
    };

export async function genericHttpPreflight<TCommand extends AdapterCommand>(
  context: GenericHttpPreflightContext,
  command: TCommand,
): Promise<PreflightOutcome<TCommand>> {
  const credentialPreflight = validateGenericHttpPreflightCredential(
    context,
    command,
  );
  if (!credentialPreflight.ok) {
    return credentialPreflight;
  }
  const { credential } = credentialPreflight;
  const sideEffectingPreflight = await validateSideEffectingPreflight(
    context,
    command,
    credential,
  );
  if (!sideEffectingPreflight.ok) {
    return sideEffectingPreflight;
  }
  const { localFingerprint, localScopeReason } = sideEffectingPreflight;
  const capabilityRoute = validateCapabilityRoutePreflight(
    context,
    command,
    credential,
    localScopeReason,
  );
  if (!capabilityRoute.ok) {
    return capabilityRoute;
  }
  const { capability, route } = capabilityRoute;
  return {
    ok: true,
    credential,
    capability,
    route,
    localFingerprint,
  };
}

function validateGenericHttpPreflightCredential<
  TCommand extends AdapterCommand,
>(
  context: GenericHttpPreflightContext,
  command: TCommand,
): CredentialPreflight<TCommand> {
  if (!operationSet.has(command.kind)) {
    return {
      ok: false,
      result: failureResult({
        code: "operation_not_supported",
        message:
          "The operation is not part of the outbound adapter contract. Use metadata ingest verification for inbound metadata.",
        retryable: false,
      }) as AdapterResultFor<TCommand>,
    };
  }
  if (command.context.connection.id !== context.connectionId) {
    return {
      ok: false,
      result: failureResult({
        code: "connection_mismatch",
        message: "The command is not bound to this adapter connection.",
        retryable: false,
      }) as AdapterResultFor<TCommand>,
    };
  }
  if (!validateIdempotencyKey(command.context.idempotency.key)) {
    return {
      ok: false,
      result: failureResult({
        code: "invalid_idempotency_key",
        message: "The idempotency key is invalid.",
        retryable: false,
      }) as AdapterResultFor<TCommand>,
    };
  }
  const credential = command.context.credential;
  if (credential === undefined) {
    return {
      ok: false,
      result: failureResult({
        code: "authentication_required",
        message: "An authenticated scoped credential is required.",
        retryable: false,
      }) as AdapterResultFor<TCommand>,
    };
  }
  if (
    !commandProviderReferencesAreValid(
      command,
      context.capabilityDocument.adapter.id,
    )
  ) {
    return {
      ok: false,
      result: failureResult({
        code: "provider_reference_mismatch",
        message:
          "A provider reference does not belong to this adapter or resource type.",
        retryable: false,
      }) as AdapterResultFor<TCommand>,
    };
  }
  return { ok: true, credential };
}

async function validateSideEffectingPreflight<TCommand extends AdapterCommand>(
  context: GenericHttpPreflightContext,
  command: TCommand,
  credential: ScopedCredential,
): Promise<SideEffectingPreflight<TCommand>> {
  const sideEffecting = isSideEffectingOperation(command.kind);
  let localFingerprint: string | undefined;
  let localScopeReason: string | undefined;
  if (sideEffecting) {
    const localScope = checkCredentialScope(credential, {
      adapterId: context.capabilityDocument.adapter.id,
      connectionId: context.connectionId,
      tenantId: command.context.tenant.id,
      environment: command.context.environment.id,
      purpose: command.kind,
      role: "command",
      host: context.baseUrl.hostname,
      now: context.clock(),
    });
    if (!localScope.ok) {
      localScopeReason = localScope.reason ?? "scope_mismatch";
    }
    try {
      localFingerprint = computeAdapterCommandFingerprint(command);
    } catch (error: unknown) {
      return {
        ok: false,
        result: failureResult({
          code: "invalid_command",
          message:
            error instanceof Error
              ? error.message
              : "The command fingerprint could not be computed.",
          retryable: false,
        }) as AdapterResultFor<TCommand>,
      };
    }
    if (
      localScopeReason === undefined &&
      context.idempotencyStore !== undefined
    ) {
      try {
        const existing = await withIdempotencyStoreDeadline(
          (signal) =>
            (context.idempotencyStore as IdempotencyStore).lookup({
              connectionId: context.connectionId,
              idempotencyKey: command.context.idempotency.key,
              commandFingerprint: localFingerprint as string,
              deadlineAt: command.context.deadline.at,
              signal,
            }),
          command.context.deadline.at,
          command.context.signal,
          context.clock,
        );
        if (existing.status === "replay") {
          return {
            ok: false,
            result: existing.result as AdapterResultFor<TCommand>,
          };
        }
        if (existing.status === "conflict") {
          return {
            ok: false,
            result: failureResult({
              code: "idempotency_conflict",
              message: `The key is already bound to ${existing.operation}.`,
              retryable: false,
            }) as AdapterResultFor<TCommand>,
          };
        }
        if (existing.status === "in_progress") {
          return {
            ok: false,
            result: unknownForOperation(
              command.kind,
              "An identical command is already in progress.",
            ) as AdapterResultFor<TCommand>,
          };
        }
      } catch (error: unknown) {
        return {
          ok: false,
          result: failureResult({
            code: isDeadlineError(error)
              ? "deadline_exceeded"
              : "idempotency_store_unavailable",
            message: isDeadlineError(error)
              ? "The command deadline expired during idempotency lookup."
              : "The durable idempotency store is unavailable; replay safety cannot be established.",
            retryable: true,
          }) as AdapterResultFor<TCommand>,
        };
      }
    }
  }
  return { ok: true, localFingerprint, localScopeReason };
}

function validateCapabilityRoutePreflight<TCommand extends AdapterCommand>(
  context: GenericHttpPreflightContext,
  command: TCommand,
  credential: ScopedCredential,
  localScopeReason: string | undefined,
): CapabilityRoutePreflight<TCommand> {
  const capability = context.capabilityDocument.capabilities[command.kind];
  if (capability.status === "unsupported") {
    return {
      ok: false,
      result: unsupportedResult(
        command.kind,
        capability.reason ?? "The operation is not configured.",
      ) as AdapterResultFor<TCommand>,
    };
  }
  if (localScopeReason !== undefined) {
    return {
      ok: false,
      result: failureResult({
        code: `auth.${localScopeReason}`,
        message: "The credential is outside its local command scope.",
        retryable: false,
      }) as AdapterResultFor<TCommand>,
    };
  }
  const route = context.routes[command.kind];
  if (route === undefined) {
    return {
      ok: false,
      result: failureResult({
        code: "adapter_misconfigured",
        message: "The advertised route is unavailable.",
        retryable: false,
      }) as AdapterResultFor<TCommand>,
    };
  }
  if (
    command.kind !== "metadata.poll" &&
    command.kind !== "metadata.backfill" &&
    (context.responseCredential?.id === credential.id ||
      (context.responseCredential !== undefined &&
        hasSameSecretMaterial(
          context.responseCredential.secret,
          credential.secret,
        )))
  ) {
    return {
      ok: false,
      result: failureResult({
        code: "response_credential_not_distinct",
        message:
          "The provider acknowledgement must use a distinct response-role credential.",
        retryable: false,
      }) as AdapterResultFor<TCommand>,
    };
  }
  return {
    ok: true,
    // The unsupported branch above returned early, so the status is narrowed.
    capability: capability as AdapterCapability & {
      readonly status: "degraded" | "supported";
    },
    route,
  };
}
