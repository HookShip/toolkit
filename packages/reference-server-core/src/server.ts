// SPDX-License-Identifier: Apache-2.0

import fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";

import type { SecretCipher } from "./crypto.js";
import {
  DisabledPayloadStorage,
  type PayloadMaintenanceController,
  type PayloadStorage,
} from "./payload-storage.js";
import { ReferenceService, type ReferenceServiceOptions } from "./service.js";
import {
  publicPayloadMaintenanceStatus,
  type PublicPayloadMaintenanceStatus,
} from "./http/public-view.js";
import { registerJsonParser } from "./http/server-security.js";
import { registerLifecycle } from "./http/server-lifecycle.js";
import { referenceOpenApiOptions } from "./http/server-openapi.js";
import { startReferencePayloadMaintenance } from "./http/server-payload-maintenance.js";
import { registerEndpointRoutes } from "./routes/endpoint-routes.js";
import { registerMetadataRoutes } from "./routes/metadata-routes.js";
import { registerReleaseRoutes } from "./routes/release-routes.js";
import { registerSecretRoutes } from "./routes/secret-routes.js";
import { registerSubscriptionRoutes } from "./routes/subscription-routes.js";
import { registerSystemRoutes } from "./routes/system-routes.js";
import {
  registerTestCommandRoutes,
  registerTestReceiverRoute,
} from "./routes/test-command-routes.js";
import type { RouteContext } from "./route-context.js";
import type { ReferenceRepository, ReferenceServerConfig } from "./types.js";

export interface BuildReferenceServerOptions {
  readonly repository: ReferenceRepository;
  readonly cipher: SecretCipher;
  readonly config: ReferenceServerConfig;
  readonly payloadStorage?: PayloadStorage;
  readonly transport?: ReferenceServiceOptions["transport"];
  readonly clock?: ReferenceServiceOptions["clock"];
  readonly idFactory?: ReferenceServiceOptions["idFactory"];
  readonly backgroundFailureReporter?: (failure: {
    readonly operation: "payload_maintenance";
    readonly failureCount: number;
    readonly errorCode?: string;
  }) => void;
}

export interface BuiltReferenceServer {
  readonly app: FastifyInstance;
  readonly payloadMaintenance?: PayloadMaintenanceController;
  readonly service: ReferenceService;
}

export async function buildReferenceServer(
  options: BuildReferenceServerOptions,
): Promise<BuiltReferenceServer> {
  const payloadStorage = options.payloadStorage ?? new DisabledPayloadStorage();
  let cleanupRequiredWithoutStorage = false;
  const refreshCleanupRequirement = async (): Promise<boolean> => {
    if (payloadStorage.capabilities.cleanup) {
      cleanupRequiredWithoutStorage = false;
      return false;
    }
    cleanupRequiredWithoutStorage =
      await options.repository.hasPayloadPersistenceState();
    return cleanupRequiredWithoutStorage;
  };
  if (!payloadStorage.capabilities.cleanup) {
    try {
      await refreshCleanupRequirement();
    } catch {
      cleanupRequiredWithoutStorage = true;
    }
  }
  const service = new ReferenceService({
    repository: options.repository,
    cipher: options.cipher,
    config: options.config,
    payloadStorage,
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.idFactory === undefined
      ? {}
      : { idFactory: options.idFactory }),
  });
  const app = fastify({
    bodyLimit: options.config.requestBodyLimitBytes,
    connectionTimeout: 15_000,
    ...(options.config.tls === undefined
      ? {}
      : {
          https: {
            cert: options.config.tls.certificate,
            key: options.config.tls.privateKey,
          },
        }),
    logger: false,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 256 },
    trustProxy: false,
  });
  const payloadMaintenance = startReferencePayloadMaintenance(
    options,
    payloadStorage,
  );
  const maintenanceStatus = (): PublicPayloadMaintenanceStatus =>
    publicPayloadMaintenanceStatus(
      payloadMaintenance,
      payloadStorage.capabilities,
      options.config.payloadRetention.enabled,
      cleanupRequiredWithoutStorage,
    );
  const ctx: RouteContext = {
    options,
    service,
    payloadStorage,
    ...(payloadMaintenance === undefined ? {} : { payloadMaintenance }),
    maintenanceStatus,
    refreshCleanupRequirement,
    cleanupRequiredWithoutStorage: () => cleanupRequiredWithoutStorage,
    setCleanupRequiredWithoutStorage: (value) => {
      cleanupRequiredWithoutStorage = value;
    },
  };

  registerJsonParser(app);
  await app.register(swagger, referenceOpenApiOptions);

  registerLifecycle(app, ctx);
  registerSystemRoutes(app, ctx);
  registerReleaseRoutes(app, ctx);
  registerEndpointRoutes(app, ctx);
  registerSubscriptionRoutes(app, ctx);
  registerSecretRoutes(app, ctx);
  registerTestCommandRoutes(app, ctx);
  registerMetadataRoutes(app, ctx);
  registerTestReceiverRoute(app, ctx);

  await payloadMaintenance?.runNow().catch(() => undefined);

  return {
    app,
    service,
    ...(payloadMaintenance === undefined ? {} : { payloadMaintenance }),
  };
}
