// SPDX-License-Identifier: Apache-2.0

import type {
  AdapterCapabilityDocument,
  AdapterOperation,
} from "./capabilities.js";
import type { AdapterExecutionContext } from "./context.js";
import type {
  CanonicalMetadataRecord,
  DeliveryAttemptReduction,
} from "./metadata.js";
import type {
  AdapterJsonValue,
  EndpointDefinition,
  EndpointDeleteOutput,
  EndpointOperationOutput,
  EndpointPatch,
  EndpointVerifyOutput,
  RequestReplayOutput,
  ResourceLocator,
  SecretCreateMaterial,
  SecretOperationOutput,
  SendTestOutput,
  SubscriptionDefinition,
  SubscriptionOperationOutput,
} from "./model.js";
import type { AdapterResult } from "./results.js";
import type { SecretValue } from "./secret.js";

export interface AdapterCommandInputMap {
  readonly "endpoint.create": {
    readonly endpoint: EndpointDefinition;
  };
  readonly "endpoint.delete": {
    readonly endpoint: ResourceLocator;
  };
  readonly "endpoint.pause": {
    readonly endpoint: ResourceLocator;
  };
  readonly "endpoint.read": {
    readonly endpoint: ResourceLocator;
  };
  readonly "endpoint.resume": {
    readonly endpoint: ResourceLocator;
  };
  readonly "endpoint.update": {
    readonly endpoint: ResourceLocator;
    readonly patch: EndpointPatch;
  };
  readonly "endpoint.verify": {
    readonly endpoint: ResourceLocator;
  };
  readonly "metadata.backfill": {
    readonly cursor?: string;
    readonly from: string;
    readonly limit?: number;
    readonly to: string;
  };
  readonly "metadata.poll": {
    readonly cursor?: string;
    readonly limit?: number;
  };
  readonly request_replay: {
    readonly deliveryId: string;
    readonly endpoint?: ResourceLocator;
    readonly reason?: string;
  };
  readonly "secret.create": {
    readonly endpoint: ResourceLocator;
    readonly material?: SecretCreateMaterial;
  };
  readonly "secret.revoke": {
    readonly secret: ResourceLocator;
  };
  readonly "secret.rotate_with_overlap": {
    readonly overlapUntil: string;
    readonly replacement?: SecretValue;
    readonly secret: ResourceLocator;
  };
  readonly send_test: {
    readonly endpoint: ResourceLocator;
    readonly eventType: string;
    readonly payload?: AdapterJsonValue;
  };
  readonly "subscription.pause": {
    readonly subscription: ResourceLocator;
  };
  readonly "subscription.read": {
    readonly subscription: ResourceLocator;
  };
  readonly "subscription.replace": {
    readonly definition: SubscriptionDefinition;
    readonly subscription?: ResourceLocator;
  };
  readonly "subscription.resume": {
    readonly subscription: ResourceLocator;
  };
}

export interface AdapterCommandBase<TKind extends AdapterOperation> {
  readonly context: AdapterExecutionContext;
  readonly input: AdapterCommandInputMap[TKind];
  readonly kind: TKind;
}

export type EndpointCreateCommand = AdapterCommandBase<"endpoint.create">;
export type EndpointReadCommand = AdapterCommandBase<"endpoint.read">;
export type EndpointUpdateCommand = AdapterCommandBase<"endpoint.update">;
export type EndpointPauseCommand = AdapterCommandBase<"endpoint.pause">;
export type EndpointResumeCommand = AdapterCommandBase<"endpoint.resume">;
export type EndpointDeleteCommand = AdapterCommandBase<"endpoint.delete">;
export type EndpointVerifyCommand = AdapterCommandBase<"endpoint.verify">;
export type SubscriptionReadCommand = AdapterCommandBase<"subscription.read">;
export type SubscriptionReplaceCommand =
  AdapterCommandBase<"subscription.replace">;
export type SubscriptionPauseCommand = AdapterCommandBase<"subscription.pause">;
export type SubscriptionResumeCommand =
  AdapterCommandBase<"subscription.resume">;
export type SecretCreateCommand = AdapterCommandBase<"secret.create">;
export type SecretRotateWithOverlapCommand =
  AdapterCommandBase<"secret.rotate_with_overlap">;
export type SecretRevokeCommand = AdapterCommandBase<"secret.revoke">;
export type SendTestCommand = AdapterCommandBase<"send_test">;
export type RequestReplayCommand = AdapterCommandBase<"request_replay">;
export type MetadataPollCommand = AdapterCommandBase<"metadata.poll">;
export type MetadataBackfillCommand = AdapterCommandBase<"metadata.backfill">;

export type AdapterCommand = {
  readonly [TKind in AdapterOperation]: AdapterCommandBase<TKind>;
}[AdapterOperation];

export interface MetadataReadOutput {
  readonly cursor?: string;
  readonly hasMore: boolean;
  readonly records: readonly CanonicalMetadataRecord[];
  readonly reductions: readonly DeliveryAttemptReduction[];
}

export interface AdapterCommandResultMap {
  readonly "endpoint.create": AdapterResult<EndpointOperationOutput>;
  readonly "endpoint.delete": AdapterResult<EndpointDeleteOutput>;
  readonly "endpoint.pause": AdapterResult<EndpointOperationOutput>;
  readonly "endpoint.read": AdapterResult<EndpointOperationOutput>;
  readonly "endpoint.resume": AdapterResult<EndpointOperationOutput>;
  readonly "endpoint.update": AdapterResult<EndpointOperationOutput>;
  readonly "endpoint.verify": AdapterResult<EndpointVerifyOutput>;
  readonly "metadata.backfill": AdapterResult<MetadataReadOutput>;
  readonly "metadata.poll": AdapterResult<MetadataReadOutput>;
  readonly request_replay: AdapterResult<RequestReplayOutput>;
  readonly "secret.create": AdapterResult<SecretOperationOutput>;
  readonly "secret.revoke": AdapterResult<SecretOperationOutput>;
  readonly "secret.rotate_with_overlap": AdapterResult<SecretOperationOutput>;
  readonly send_test: AdapterResult<SendTestOutput>;
  readonly "subscription.pause": AdapterResult<SubscriptionOperationOutput>;
  readonly "subscription.read": AdapterResult<SubscriptionOperationOutput>;
  readonly "subscription.replace": AdapterResult<SubscriptionOperationOutput>;
  readonly "subscription.resume": AdapterResult<SubscriptionOperationOutput>;
}

export type AdapterCommandResult =
  AdapterCommandResultMap[keyof AdapterCommandResultMap];

export type AdapterResultFor<TCommand extends AdapterCommand> =
  AdapterCommandResultMap[TCommand["kind"]];

export interface Adapter {
  readonly capabilityDocument: AdapterCapabilityDocument;
  execute<TCommand extends AdapterCommand>(
    command: TCommand,
  ): Promise<AdapterResultFor<TCommand>>;
}

export function adapterCommandOperation(
  command: AdapterCommand,
): AdapterOperation {
  return command.kind;
}
