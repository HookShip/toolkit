// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { Client as MinioClient } from "minio";
import { Pool } from "pg";

import { AesGcmSecretCipher } from "./crypto.js";
import { migratePostgres } from "./migrations.js";
import {
  DisabledPayloadStorage,
  MinioPayloadStorage,
  payloadBucketName,
  type PayloadMaintenanceController,
  type PayloadStorage,
  type PayloadStorageCapabilities,
} from "./payload-storage.js";
import { PostgresReferenceRepository } from "./postgres-repository.js";
import {
  buildReferenceServer,
  type BuildReferenceServerOptions,
} from "./server.js";
import {
  DEFAULT_REFERENCE_SERVER_CONFIG,
  type ReferenceServerConfig,
} from "./types.js";

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new RangeError(`${name} is required.`);
  }
  return value;
}

function secureFileValue(environment: NodeJS.ProcessEnv, name: string): string {
  const resolved = path.resolve(requiredEnvironment(environment, name));
  const metadata = statSync(resolved);
  if (!metadata.isFile()) {
    throw new RangeError(`${name} must reference a regular file.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new RangeError(
      `${name} permissions must not grant group or other access.`,
    );
  }
  const value = readFileSync(resolved, "utf8").replace(/\r?\n$/u, "");
  if (value.length === 0 || Buffer.byteLength(value) > 4096) {
    throw new RangeError(`${name} is empty or exceeds its size limit.`);
  }
  return value;
}

function requiredEnvironmentOrFile(
  environment: NodeJS.ProcessEnv,
  environmentName: string,
  fileEnvironmentName: string,
): string {
  const direct = environment[environmentName]?.trim();
  const file = environment[fileEnvironmentName]?.trim();
  if (direct && file) {
    throw new RangeError(
      `Choose either ${environmentName} or ${fileEnvironmentName}.`,
    );
  }
  return file
    ? secureFileValue(environment, fileEnvironmentName)
    : requiredEnvironment(environment, environmentName);
}

function booleanEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined) {
    return fallback;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new RangeError(`${name} must be true, false, 1, or 0.`);
}

function integerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function payloadIdentityEnvironment(environment: NodeJS.ProcessEnv): {
  readonly namespaceId: string;
  readonly storeId: string;
} {
  const namespace = requiredEnvironment(
    environment,
    "REFERENCE_PAYLOAD_NAMESPACE_ID",
  );
  const storeId = requiredEnvironment(
    environment,
    "REFERENCE_PAYLOAD_STORE_ID",
  );
  payloadBucketName(namespace, storeId);
  return { namespaceId: namespace, storeId };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

export function referenceServerConfigFromEnv(
  environment: NodeJS.ProcessEnv,
  overrides: Partial<
    Pick<ReferenceServerConfig, "host" | "port" | "allowLocalNetwork">
  > = {},
): ReferenceServerConfig {
  const host =
    overrides.host ??
    environment["REFERENCE_HOST"] ??
    DEFAULT_REFERENCE_SERVER_CONFIG.host;
  const port =
    overrides.port ??
    integerEnvironment(
      environment,
      "REFERENCE_PORT",
      DEFAULT_REFERENCE_SERVER_CONFIG.port,
      0,
      65_535,
    );
  const tlsCertificateFile =
    environment["REFERENCE_TLS_CERT_FILE"]?.trim() || undefined;
  const tlsKeyFile = environment["REFERENCE_TLS_KEY_FILE"]?.trim() || undefined;
  if ((tlsCertificateFile === undefined) !== (tlsKeyFile === undefined)) {
    throw new RangeError(
      "REFERENCE_TLS_CERT_FILE and REFERENCE_TLS_KEY_FILE must be configured together.",
    );
  }
  if (
    !isLoopbackHost(host) &&
    (tlsCertificateFile === undefined || tlsKeyFile === undefined)
  ) {
    throw new RangeError(
      "Non-loopback bindings require REFERENCE_TLS_CERT_FILE and REFERENCE_TLS_KEY_FILE.",
    );
  }
  let tls: ReferenceServerConfig["tls"];
  if (tlsCertificateFile !== undefined && tlsKeyFile !== undefined) {
    const certificatePath = path.resolve(tlsCertificateFile);
    const privateKeyPath = path.resolve(tlsKeyFile);
    const certificateMetadata = statSync(certificatePath);
    const privateKeyMetadata = statSync(privateKeyPath);
    if (!certificateMetadata.isFile()) {
      throw new RangeError(
        "REFERENCE_TLS_CERT_FILE must reference a regular file.",
      );
    }
    if (
      !privateKeyMetadata.isFile() ||
      (privateKeyMetadata.mode & 0o077) !== 0
    ) {
      throw new RangeError(
        "REFERENCE_TLS_KEY_FILE must be a permission-restricted regular file.",
      );
    }
    tls = {
      certificate: readFileSync(certificatePath),
      privateKey: readFileSync(privateKeyPath),
    };
  }
  const apiToken = requiredEnvironmentOrFile(
    environment,
    "REFERENCE_API_TOKEN",
    "REFERENCE_API_TOKEN_FILE",
  );
  const payloadIdentity = payloadIdentityEnvironment(environment);
  return {
    apiToken,
    ...(tls === undefined ? {} : { tls }),
    host,
    port,
    allowLocalNetwork:
      overrides.allowLocalNetwork ??
      booleanEnvironment(
        environment,
        "REFERENCE_ALLOW_LOCAL_NETWORK",
        DEFAULT_REFERENCE_SERVER_CONFIG.allowLocalNetwork,
      ),
    contractBodyLimitBytes: integerEnvironment(
      environment,
      "REFERENCE_CONTRACT_BODY_LIMIT_BYTES",
      DEFAULT_REFERENCE_SERVER_CONFIG.contractBodyLimitBytes,
      1024,
      16 * 1024 * 1024,
    ),
    requestBodyLimitBytes: integerEnvironment(
      environment,
      "REFERENCE_BODY_LIMIT_BYTES",
      DEFAULT_REFERENCE_SERVER_CONFIG.requestBodyLimitBytes,
      1024,
      16 * 1024 * 1024,
    ),
    sendTestBodyLimitBytes: integerEnvironment(
      environment,
      "REFERENCE_TEST_BODY_LIMIT_BYTES",
      DEFAULT_REFERENCE_SERVER_CONFIG.sendTestBodyLimitBytes,
      1024,
      1024 * 1024,
    ),
    sendTestTimeoutMilliseconds: integerEnvironment(
      environment,
      "REFERENCE_TEST_TIMEOUT_MS",
      DEFAULT_REFERENCE_SERVER_CONFIG.sendTestTimeoutMilliseconds,
      100,
      30_000,
    ),
    metadataIdentity: {
      adapterId:
        environment["REFERENCE_ADAPTER_ID"] ??
        DEFAULT_REFERENCE_SERVER_CONFIG.metadataIdentity.adapterId,
      connectionId:
        environment["REFERENCE_CONNECTION_ID"] ??
        DEFAULT_REFERENCE_SERVER_CONFIG.metadataIdentity.connectionId,
      environment:
        environment["REFERENCE_ENVIRONMENT"] ??
        DEFAULT_REFERENCE_SERVER_CONFIG.metadataIdentity.environment,
      tenantId:
        environment["REFERENCE_TENANT_ID"] ??
        DEFAULT_REFERENCE_SERVER_CONFIG.metadataIdentity.tenantId,
    },
    payloadStorageNamespaceId: payloadIdentity.namespaceId,
    payloadStorageStoreId: payloadIdentity.storeId,
    ingestCredential: {
      id: environment["REFERENCE_INGEST_CREDENTIAL_ID"] ?? "local-ingest",
      secret: requiredEnvironment(environment, "REFERENCE_INGEST_SECRET"),
    },
    payloadRetention: {
      enabled: booleanEnvironment(
        environment,
        "REFERENCE_PAYLOAD_RETENTION",
        false,
      ),
      ttlSeconds: integerEnvironment(
        environment,
        "REFERENCE_PAYLOAD_TTL_SECONDS",
        DEFAULT_REFERENCE_SERVER_CONFIG.payloadRetention.ttlSeconds,
        60,
        30 * 24 * 60 * 60,
      ),
    },
    payloadMaintenance: {
      batchSize: integerEnvironment(
        environment,
        "REFERENCE_PAYLOAD_MAINTENANCE_BATCH_SIZE",
        DEFAULT_REFERENCE_SERVER_CONFIG.payloadMaintenance.batchSize,
        1,
        10_000,
      ),
      gracePeriodMilliseconds:
        integerEnvironment(
          environment,
          "REFERENCE_PAYLOAD_MAINTENANCE_GRACE_SECONDS",
          Math.ceil(
            DEFAULT_REFERENCE_SERVER_CONFIG.payloadMaintenance
              .gracePeriodMilliseconds / 1000,
          ),
          1,
          24 * 60 * 60,
        ) * 1000,
      intervalMilliseconds:
        integerEnvironment(
          environment,
          "REFERENCE_PAYLOAD_MAINTENANCE_INTERVAL_SECONDS",
          Math.ceil(
            DEFAULT_REFERENCE_SERVER_CONFIG.payloadMaintenance
              .intervalMilliseconds / 1000,
          ),
          1,
          24 * 60 * 60,
        ) * 1000,
    },
  };
}

export function payloadStorageFromEnv(
  environment: NodeJS.ProcessEnv,
  config: ReferenceServerConfig,
): PayloadStorage {
  const objectStorageConfigured = [
    environment["MINIO_ENDPOINT"],
    environment["MINIO_ACCESS_KEY"],
    environment["MINIO_SECRET_KEY"],
  ].some((value) => value?.trim());
  if (!objectStorageConfigured && !config.payloadRetention.enabled) {
    return new DisabledPayloadStorage();
  }
  const endPoint = requiredEnvironment(environment, "MINIO_ENDPOINT");
  const port = integerEnvironment(environment, "MINIO_PORT", 9000, 1, 65_535);
  const useSSL = booleanEnvironment(environment, "MINIO_USE_SSL", false);
  const expectedBucket = payloadBucketName(
    config.payloadStorageNamespaceId,
    config.payloadStorageStoreId,
  );
  const configuredBucket = requiredEnvironment(
    environment,
    "MINIO_PAYLOAD_BUCKET",
  );
  if (configuredBucket !== expectedBucket) {
    throw new RangeError(
      "MINIO_PAYLOAD_BUCKET must exactly match the canonical bucket derived from REFERENCE_PAYLOAD_NAMESPACE_ID and REFERENCE_PAYLOAD_STORE_ID.",
    );
  }
  const client = new MinioClient({
    endPoint,
    port,
    useSSL,
    accessKey: requiredEnvironment(environment, "MINIO_ACCESS_KEY"),
    secretKey: requiredEnvironment(environment, "MINIO_SECRET_KEY"),
  });
  return new MinioPayloadStorage({
    client,
    bucket: configuredBucket,
    lifecyclePolicy: {
      prefix: "payloads/",
      expireAfterDays: Math.max(
        1,
        Math.ceil(config.payloadRetention.ttlSeconds / (24 * 60 * 60)),
      ),
      abortIncompleteMultipartAfterDays: 1,
    },
    ...(environment["MINIO_REGION"] === undefined
      ? {}
      : { region: environment["MINIO_REGION"] }),
  });
}

export interface StartReferenceServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly configOverrides?: Partial<
    Pick<ReferenceServerConfig, "host" | "port" | "allowLocalNetwork">
  >;
  readonly autoMigrate?: boolean;
  readonly buildOverrides?: Partial<
    Pick<BuildReferenceServerOptions, "clock" | "idFactory" | "transport">
  >;
}

export interface RunningReferenceServer {
  readonly address: string;
  readonly app: import("fastify").FastifyInstance;
  readonly payloadCaptureEnabled: boolean;
  readonly payloadMaintenance?: PayloadMaintenanceController;
  readonly payloadStorageCapabilities: PayloadStorageCapabilities;
  close(): Promise<void>;
}

export async function startReferenceServerFromEnv(
  options: StartReferenceServerOptions = {},
): Promise<RunningReferenceServer> {
  const environment = options.environment ?? process.env;
  const config = referenceServerConfigFromEnv(
    environment,
    options.configOverrides,
  );
  const pool = new Pool({
    connectionString: requiredEnvironment(environment, "DATABASE_URL"),
    max: integerEnvironment(environment, "PG_POOL_MAX", 10, 1, 100),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  if (
    options.autoMigrate === true ||
    booleanEnvironment(environment, "REFERENCE_AUTO_MIGRATE", false)
  ) {
    await migratePostgres(pool);
  }
  const repository = new PostgresReferenceRepository({ pool });
  const payloadStorage = payloadStorageFromEnv(environment, config);
  const built = await buildReferenceServer({
    repository,
    cipher: new AesGcmSecretCipher(
      requiredEnvironment(environment, "REFERENCE_MASTER_KEY"),
    ),
    config,
    payloadStorage,
    ...(options.buildOverrides?.clock === undefined
      ? {}
      : { clock: options.buildOverrides.clock }),
    ...(options.buildOverrides?.idFactory === undefined
      ? {}
      : { idFactory: options.buildOverrides.idFactory }),
    ...(options.buildOverrides?.transport === undefined
      ? {}
      : { transport: options.buildOverrides.transport }),
  });
  try {
    const address = await built.app.listen({
      host: config.host,
      port: config.port,
    });
    return {
      address,
      app: built.app,
      ...(built.payloadMaintenance === undefined
        ? {}
        : { payloadMaintenance: built.payloadMaintenance }),
      payloadCaptureEnabled: config.payloadRetention.enabled,
      payloadStorageCapabilities: payloadStorage.capabilities,
      close: async () => {
        await built.app.close();
        await pool.end();
      },
    };
  } catch (error) {
    await built.app.close();
    await pool.end();
    throw error;
  }
}

export async function migrateReferenceServerFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly string[]> {
  const pool = new Pool({
    connectionString: requiredEnvironment(environment, "DATABASE_URL"),
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  try {
    return await migratePostgres(pool);
  } finally {
    await pool.end();
  }
}

export async function runReferenceServerProcess(
  options: StartReferenceServerOptions = {},
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): Promise<void> {
  const running = await startReferenceServerFromEnv(options);
  output.write(`Reference server listening at ${running.address}\n`);
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) {
        return;
      }
      closing = true;
      void running.close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
