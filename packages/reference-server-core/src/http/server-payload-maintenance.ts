// SPDX-License-Identifier: Apache-2.0

import {
  ensurePayloadStorageIdentity,
  startPayloadMaintenance,
  type PayloadMaintenanceController,
  type PayloadStorage,
} from "../payload-storage.js";
import type { BuildReferenceServerOptions } from "../server.js";

export function startReferencePayloadMaintenance(
  options: BuildReferenceServerOptions,
  payloadStorage: PayloadStorage,
): PayloadMaintenanceController | undefined {
  const backgroundFailureReporter =
    options.backgroundFailureReporter ??
    ((failure: {
      readonly operation: "payload_maintenance";
      readonly failureCount: number;
      readonly errorCode?: string;
    }) => {
      process.stderr.write(
        `Reference background operation ${failure.operation} reported ${failure.failureCount} failure(s)${failure.errorCode === undefined ? "" : ` (${failure.errorCode})`}.\n`,
      );
    });
  return payloadStorage.capabilities.cleanup
    ? startPayloadMaintenance(options.repository, payloadStorage, {
        batchSize: options.config.payloadMaintenance.batchSize,
        gracePeriodMilliseconds:
          options.config.payloadMaintenance.gracePeriodMilliseconds,
        intervalMilliseconds:
          options.config.payloadMaintenance.intervalMilliseconds,
        preflight: async () => {
          await ensurePayloadStorageIdentity(
            options.repository,
            payloadStorage,
            {
              namespaceId: options.config.payloadStorageNamespaceId,
              storeId: options.config.payloadStorageStoreId,
              ...(options.clock === undefined ? {} : { clock: options.clock }),
            },
          );
        },
        runOnStart: false,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        onReport: (report) => {
          if (report.failureCount > 0) {
            backgroundFailureReporter({
              operation: "payload_maintenance",
              failureCount: report.failureCount,
            });
          }
        },
        onError: (errorCode) => {
          backgroundFailureReporter({
            operation: "payload_maintenance",
            failureCount: 1,
            errorCode,
          });
        },
      })
    : undefined;
}
