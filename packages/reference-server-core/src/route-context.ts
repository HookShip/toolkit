// SPDX-License-Identifier: Apache-2.0

import type {
  PayloadMaintenanceController,
  PayloadStorage,
} from "./payload-storage.js";
import type { ReferenceService } from "./service.js";
import type { BuildReferenceServerOptions } from "./server.js";
import type { PublicPayloadMaintenanceStatus } from "./http/public-view.js";

export interface RouteContext {
  readonly options: BuildReferenceServerOptions;
  readonly service: ReferenceService;
  readonly payloadStorage: PayloadStorage;
  readonly payloadMaintenance?: PayloadMaintenanceController;
  readonly maintenanceStatus: () => PublicPayloadMaintenanceStatus;
  readonly refreshCleanupRequirement: () => Promise<boolean>;
  readonly cleanupRequiredWithoutStorage: () => boolean;
  readonly setCleanupRequiredWithoutStorage: (value: boolean) => void;
}
