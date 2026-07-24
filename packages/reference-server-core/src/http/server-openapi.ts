// SPDX-License-Identifier: Apache-2.0

export const referenceOpenApiOptions = {
  openapi: {
    info: {
      title: "Webhook Portal Reference API",
      version: "1.0.0",
      description:
        "Open single-team contract, endpoint, signed-test, and metadata timeline API.",
    },
    components: {
      securitySchemes: {
        apiToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque API token",
          description:
            "Required for every control, documentation, and preview route, including loopback.",
        },
        metadataIngest: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description:
            "Webhook-Ingest signature mirrored from the authenticated ingest envelope.",
        },
        webhookSignature: {
          type: "apiKey",
          in: "header",
          name: "webhook-signature",
          description: "Standard Webhooks signature over the exact raw body.",
        },
      },
    },
  },
} as const;
