// SPDX-License-Identifier: Apache-2.0

/**
 * @deprecated Import from `@webhook-portal/reference-server-core` directly.
 *
 * The reference-server runtime was extracted into its own package so a CLI-only
 * install no longer pulls Fastify/PG/MinIO. This subpath remains as a
 * compatibility re-export and resolves only when the optional peer
 * `@webhook-portal/reference-server-core` is installed.
 */
export * from "@webhook-portal/reference-server-core";
