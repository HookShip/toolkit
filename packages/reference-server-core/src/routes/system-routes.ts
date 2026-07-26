// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { EXPECTED_REFERENCE_SCHEMA_VERSION } from "../migrations.js";
import { ReferenceApiError } from "../service.js";
import type { RouteContext } from "../route-context.js";
import type { RepositoryReadiness } from "../types.js";
import { queryObject, queryString } from "../http/request-parsing.js";
import {
  escapeHtml,
  payloadMaintenanceMetrics,
  publicSchemaReadiness,
} from "../http/public-view.js";
import { OPENAPI_OBJECT, schema } from "../http/route-schemas.js";

export function registerSystemRoutes(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  registerHealthRoutes(app, deps);
  registerMetricsRoute(app, deps);
  registerDocsRoutes(app);
  registerPreviewRoutes(app, deps);
}

function registerHealthRoutes(app: FastifyInstance, deps: RouteContext): void {
  registerLiveHealthRoute(app);
  registerReadyHealthRoute(app, deps);
  registerMaintenanceHealthRoute(app, deps);
}

function registerLiveHealthRoute(app: FastifyInstance): void {
  app.get(
    "/health/live",
    {
      schema: schema("Liveness probe", ["health"], {
        public: true,
        response: { 200: OPENAPI_OBJECT },
      }),
    },
    async () => ({ status: "ok" }),
  );
}

function registerReadyHealthRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const {
    options,
    payloadStorage,
    maintenanceStatus,
    refreshCleanupRequirement,
    cleanupRequiredWithoutStorage,
  } = deps;
  app.get(
    "/health/ready",
    {
      schema: schema("Readiness probe", ["health"], {
        public: true,
        response: { 200: OPENAPI_OBJECT, 503: OPENAPI_OBJECT },
      }),
    },
    async (_request, reply) => {
      let readiness: RepositoryReadiness;
      try {
        readiness = await options.repository.readiness();
      } catch {
        return reply.status(503).send({
          status: "not_ready",
          schema: {
            expectedVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
            currentVersion: null,
            missingVersions: [],
            unexpectedVersions: [],
            checksumMismatchVersions: [],
          },
          payloadMaintenance: maintenanceStatus(),
          reason: "repository_unavailable",
        });
      }
      const schema = publicSchemaReadiness(readiness);
      if (!readiness.ready) {
        return reply.status(503).send({
          status: "not_ready",
          schema,
          payloadMaintenance: maintenanceStatus(),
          reason: "migration_state",
        });
      }
      if (!payloadStorage.capabilities.cleanup) {
        try {
          await refreshCleanupRequirement();
        } catch {
          return reply.status(503).send({
            status: "not_ready",
            schema,
            payloadMaintenance: maintenanceStatus(),
            reason: "repository_unavailable",
          });
        }
        if (cleanupRequiredWithoutStorage()) {
          return reply.status(503).send({
            status: "not_ready",
            schema,
            payloadMaintenance: maintenanceStatus(),
            reason: "payload_storage_required",
          });
        }
      }
      if (payloadStorage.capabilities.cleanup) {
        try {
          await payloadStorage.ping();
        } catch {
          return reply.status(503).send({
            status: "not_ready",
            schema,
            payloadMaintenance: maintenanceStatus(),
            reason: "payload_storage_unavailable",
          });
        }
      }
      const maintenance = maintenanceStatus();
      if (!maintenance.ready) {
        return reply.status(503).send({
          status: "not_ready",
          schema,
          payloadMaintenance: maintenance,
          reason: "payload_maintenance",
        });
      }
      return {
        status: "ready",
        schema,
        payloadMaintenance: maintenance,
      };
    },
  );
}

function registerMaintenanceHealthRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const {
    payloadStorage,
    maintenanceStatus,
    refreshCleanupRequirement,
    setCleanupRequiredWithoutStorage,
  } = deps;
  app.get(
    "/health/maintenance",
    {
      schema: schema("Payload maintenance status", ["health"], {
        public: true,
        response: { 200: OPENAPI_OBJECT, 503: OPENAPI_OBJECT },
      }),
    },
    async (_request, reply) => {
      if (!payloadStorage.capabilities.cleanup) {
        try {
          await refreshCleanupRequirement();
        } catch {
          setCleanupRequiredWithoutStorage(true);
        }
      }
      const maintenance = maintenanceStatus();
      return reply.status(maintenance.ready ? 200 : 503).send({
        status: maintenance.ready ? "ready" : "not_ready",
        maintenance,
      });
    },
  );
}

function registerMetricsRoute(app: FastifyInstance, deps: RouteContext): void {
  const {
    payloadStorage,
    maintenanceStatus,
    refreshCleanupRequirement,
    setCleanupRequiredWithoutStorage,
  } = deps;
  app.get("/metrics", { schema: { hide: true } }, async (_request, reply) => {
    if (!payloadStorage.capabilities.cleanup) {
      try {
        await refreshCleanupRequirement();
      } catch {
        setCleanupRequiredWithoutStorage(true);
      }
    }
    return reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(payloadMaintenanceMetrics(maintenanceStatus()));
  });
}

function registerDocsRoutes(app: FastifyInstance): void {
  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );
  app.get("/docs", { schema: { hide: true } }, async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reference API documentation</title><style>
body{font:16px/1.55 system-ui,sans-serif;max-width:72rem;margin:auto;padding:2rem;color:#17202a}
a{color:#075985}code{background:#f1f5f9;padding:.15rem .3rem;border-radius:.2rem}
:focus-visible{outline:3px solid #0ea5e9;outline-offset:2px}
</style></head><body><main><h1>Webhook Portal Reference API</h1>
<p>This local single-team server exposes versioned contract releases, endpoint and secret lifecycle,
at-most-once signed tests, and an authenticated metadata timeline.</p>
<ul><li><a href="/preview">Local release preview</a></li>
<li><a href="/openapi.json">OpenAPI JSON</a></li>
<li><code>GET /health/ready</code></li>
<li><code>GET /health/maintenance</code></li>
<li><code>GET /metrics</code></li></ul>
</main></body></html>`);
  });
}

function registerPreviewRoutes(app: FastifyInstance, deps: RouteContext): void {
  const previewHandler = async (request: FastifyRequest, reply: FastifyReply) =>
    preview(request, reply, deps);
  app.get("/", { schema: { hide: true } }, previewHandler);
  app.get("/preview", { schema: { hide: true } }, previewHandler);
}

async function preview(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RouteContext,
) {
  const { options } = deps;
  const query = queryObject(request);
  const importId = queryString(query, "importId");
  const releaseId = queryString(query, "releaseId");
  if (importId !== undefined && releaseId !== undefined) {
    throw new ReferenceApiError(
      400,
      "PREVIEW_SOURCE_CONFLICT",
      "Choose either importId or releaseId for preview.",
    );
  }
  const selectedRelease =
    releaseId === undefined
      ? importId === undefined
        ? await options.repository.getActiveRelease()
        : undefined
      : await options.repository.getRelease(releaseId);
  if (releaseId !== undefined && selectedRelease === undefined) {
    throw new ReferenceApiError(
      404,
      "RELEASE_NOT_FOUND",
      "The release preview candidate was not found.",
    );
  }
  const selectedImport =
    importId === undefined
      ? undefined
      : await options.repository.getContractImport(importId);
  if (importId !== undefined && selectedImport === undefined) {
    throw new ReferenceApiError(
      404,
      "IMPORT_NOT_FOUND",
      "The contract import preview candidate was not found.",
    );
  }
  if (selectedImport !== undefined && selectedImport.contract === undefined) {
    throw new ReferenceApiError(
      422,
      "IMPORT_NOT_PREVIEWABLE",
      "The contract import has no previewable canonical contract.",
      { importStatus: selectedImport.status },
    );
  }
  const contract = selectedImport?.contract ?? selectedRelease?.contract;
  const previewLabel =
    selectedImport !== undefined
      ? `Draft import ${selectedImport.id}`
      : selectedRelease !== undefined
        ? `${selectedRelease.active ? "Active" : "Candidate"} release ${selectedRelease.id}`
        : "No active release";
  const endpoints = await options.repository.listEndpoints();
  const timeline = await options.repository.listTimeline({ limit: 20 });
  const events =
    contract?.eventTypes
      .map(
        (
          event,
        ) => `<article><h2>${escapeHtml(event.title ?? event.externalName)}</h2>
<p><code>${escapeHtml(event.externalName)}</code></p>
${event.description === undefined ? "" : `<p>${escapeHtml(event.description)}</p>`}
<ul>${event.versions
          .map(
            (version) =>
              `<li>Version ${escapeHtml(version.publicVersion)} — ${version.examples.length} example(s)</li>`,
          )
          .join("")}</ul></article>`,
      )
      .join("") ?? "<p>No release has been published.</p>";
  return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Webhook Portal local preview</title><style>
body{font:16px/1.55 system-ui,sans-serif;max-width:72rem;margin:auto;padding:2rem;color:#17202a}
header{border-bottom:1px solid #cbd5e1;margin-bottom:2rem}.meta{color:#475569}
article,section{padding:1rem 0;border-bottom:1px solid #e2e8f0}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid #e2e8f0}a{color:#075985}
:focus-visible{outline:3px solid #0ea5e9;outline-offset:2px}
</style></head><body><a href="#content">Skip to content</a><header>
<h1>${escapeHtml(contract?.title ?? "Webhook Portal local preview")}</h1>
<p class="meta">Environment: ${escapeHtml(options.config.metadataIdentity.environment)} ·
${escapeHtml(previewLabel)}</p></header>
<main id="content"><section aria-labelledby="events"><h2 id="events">Event catalog</h2>${events}</section>
<section aria-labelledby="endpoints"><h2 id="endpoints">Endpoints</h2>
<p>${endpoints.length} configured endpoint(s). Secret values are never displayed here.</p></section>
<section aria-labelledby="timeline"><h2 id="timeline">Recent timeline</h2>
${
  timeline.items.length === 0
    ? "<p>No metadata yet. Payload not stored.</p>"
    : `<table><thead><tr><th>Event</th><th>Status</th><th>Occurred</th><th>Payload</th></tr></thead><tbody>${timeline.items
        .map(
          (entry) =>
            `<tr><td>${escapeHtml(entry.current.eventVersion.eventType)}</td><td>${escapeHtml(entry.current.status)}</td><td>${escapeHtml(entry.current.occurredAt)}</td><td>${entry.payloadRetained ? "retained locally with TTL" : "not stored"}</td></tr>`,
        )
        .join("")}</tbody></table>`
}</section>
<p><a href="/docs">API documentation</a></p></main></body></html>`);
}
