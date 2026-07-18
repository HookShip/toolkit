// SPDX-License-Identifier: Apache-2.0

import type { AdapterOperation } from "./capabilities.js";
import { isWellFormedUnicode } from "./canonical.js";
import {
  deadlineAt,
  normalizeDeadline,
  type AdapterDeadline,
  type DeadlineInput,
} from "./deadline.js";
import { SecretValue } from "./secret.js";

export interface TenantContext {
  readonly id: string;
  readonly organizationId?: string;
}

export type ActorType = "human" | "service" | "system";

export interface ActorContext {
  readonly id: string;
  readonly type: ActorType;
}

export interface EnvironmentContext {
  readonly id: string;
  readonly name?: string;
}

export interface ConnectionContext {
  readonly id: string;
}

export interface IdempotencyContext {
  readonly key: string;
  readonly namespace?: string;
}

export type ScopedCredentialKind = "basic" | "bearer" | "header";
export type CredentialRole = "command" | "metadata_ingest" | "response";
export type CredentialPurpose =
  AdapterOperation | "acknowledgement.verify" | "metadata.ingest";

export interface CredentialScope {
  readonly adapterId?: string;
  readonly connectionId?: string;
  readonly environments?: readonly string[];
  readonly expiresAt?: number;
  readonly hosts?: readonly string[];
  readonly operations?: readonly CredentialPurpose[];
  readonly tenantId?: string;
}

export interface ScopedCredential {
  readonly headerName?: string;
  readonly id: string;
  readonly kind: ScopedCredentialKind;
  readonly prefix?: string;
  readonly role: CredentialRole;
  readonly scope: CredentialScope;
  readonly secret: SecretValue;
}

export interface AdapterExecutionContext {
  readonly actor: ActorContext;
  readonly connection: ConnectionContext;
  readonly credential?: ScopedCredential;
  readonly deadline: AdapterDeadline;
  readonly environment: EnvironmentContext;
  readonly idempotency: IdempotencyContext;
  readonly signal?: AbortSignal;
  readonly tenant: TenantContext;
}

export interface CreateAdapterContextInput {
  readonly actor: ActorContext;
  readonly connection: ConnectionContext;
  readonly credential?: ScopedCredential;
  readonly deadline?: DeadlineInput;
  readonly environment: EnvironmentContext;
  readonly idempotency: IdempotencyContext;
  readonly signal?: AbortSignal;
  readonly tenant: TenantContext;
}

function validateIdentifier(name: string, value: string): void {
  if (
    value.length === 0 ||
    value.length > 512 ||
    !isWellFormedUnicode(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(`${name} must be a non-empty safe string.`);
  }
}

export function validateIdempotencyKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 512 &&
    isWellFormedUnicode(key) &&
    !/[\u0000-\u0020\u007f]/u.test(key)
  );
}

export function createAdapterContext(
  input: CreateAdapterContextInput,
): AdapterExecutionContext {
  validateIdentifier("tenant.id", input.tenant.id);
  validateIdentifier("actor.id", input.actor.id);
  validateIdentifier("connection.id", input.connection.id);
  validateIdentifier("environment.id", input.environment.id);
  if (!validateIdempotencyKey(input.idempotency.key)) {
    throw new RangeError("The idempotency key is invalid.");
  }

  return Object.freeze({
    tenant: Object.freeze({ ...input.tenant }),
    actor: Object.freeze({ ...input.actor }),
    connection: Object.freeze({ ...input.connection }),
    environment: Object.freeze({ ...input.environment }),
    idempotency: Object.freeze({ ...input.idempotency }),
    deadline: normalizeDeadline(
      input.deadline ?? deadlineAt(Date.now() + 30_000),
    ),
    ...(input.credential === undefined
      ? {}
      : {
          credential: Object.freeze({
            ...input.credential,
            scope: Object.freeze({ ...input.credential.scope }),
          }),
        }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export interface CredentialScopeCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

function hostMatchesScope(host: string, pattern: string): boolean {
  const candidate = host.toLowerCase().replace(/\.$/u, "");
  const allowed = pattern.toLowerCase().replace(/\.$/u, "");
  if (allowed.startsWith("*.")) {
    const suffix = allowed.slice(1);
    return candidate.endsWith(suffix) && candidate.length > suffix.length;
  }
  return candidate === allowed;
}

export function checkCredentialScope(
  credential: ScopedCredential,
  input: {
    readonly adapterId: string;
    readonly connectionId: string;
    readonly environment: string;
    readonly host?: string;
    readonly now?: number;
    readonly purpose: CredentialPurpose;
    readonly role: CredentialRole;
    readonly tenantId: string;
  },
): CredentialScopeCheck {
  const scope = credential.scope;
  const now = input.now ?? Date.now();
  let reason: string | undefined;

  if (credential.role !== input.role) {
    reason = "credential_role_mismatch";
  } else if (
    scope.expiresAt !== undefined &&
    (!Number.isFinite(scope.expiresAt) || scope.expiresAt <= now)
  ) {
    reason = "credential_expired";
  } else if (
    scope.connectionId !== undefined &&
    scope.connectionId !== input.connectionId
  ) {
    reason = "connection_scope_mismatch";
  } else if (
    scope.adapterId !== undefined &&
    scope.adapterId !== input.adapterId
  ) {
    reason = "adapter_scope_mismatch";
  } else if (
    scope.tenantId !== undefined &&
    scope.tenantId !== input.tenantId
  ) {
    reason = "tenant_scope_mismatch";
  } else if (
    scope.environments !== undefined &&
    !scope.environments.includes(input.environment)
  ) {
    reason = "environment_scope_mismatch";
  } else if (
    scope.operations !== undefined &&
    !scope.operations.includes(input.purpose)
  ) {
    reason = "operation_scope_mismatch";
  } else if (
    scope.hosts !== undefined &&
    scope.hosts.length > 0 &&
    (input.host === undefined ||
      !scope.hosts.some((host) => hostMatchesScope(input.host as string, host)))
  ) {
    reason = "host_scope_mismatch";
  }

  return reason === undefined
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, reason });
}
