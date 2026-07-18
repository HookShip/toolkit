// SPDX-License-Identifier: Apache-2.0

import type { JsonSchema } from "./json.js";
import {
  CANONICAL_EXPORT_FORMAT,
  CANONICAL_EXPORT_SCHEMA_ID,
  CANONICAL_EXPORT_VERSION,
  CANONICAL_MODEL_VERSION,
  CANONICAL_SCHEMA_ID,
  JSON_SCHEMA_2020_12_DIALECT,
} from "./model.js";

const checksumSchema: JsonSchema = {
  additionalProperties: false,
  properties: {
    algorithm: { const: "sha256" },
    value: { pattern: "^[a-f0-9]{64}$", type: "string" },
  },
  required: ["algorithm", "value"],
  type: "object",
};

const sourcePointerSchema: JsonSchema = {
  additionalProperties: false,
  properties: {
    location: {
      additionalProperties: false,
      properties: {
        end: { $ref: "#/$defs/location" },
        start: { $ref: "#/$defs/location" },
      },
      required: ["start"],
      type: "object",
    },
    pointer: { type: "string" },
  },
  required: ["pointer"],
  type: "object",
};

export const CANONICAL_CONTRACT_JSON_SCHEMA: JsonSchema = {
  $defs: {
    checksum: checksumSchema,
    eventType: {
      additionalProperties: false,
      properties: {
        description: { type: "string" },
        extensions: { type: "object" },
        externalName: { minLength: 1, type: "string" },
        id: { minLength: 1, type: "string" },
        title: { type: "string" },
        versions: {
          items: { $ref: "#/$defs/eventVersion" },
          minItems: 1,
          type: "array",
        },
      },
      required: ["externalName", "id", "versions"],
      type: "object",
    },
    eventVersion: {
      additionalProperties: false,
      properties: {
        deprecation: {
          additionalProperties: false,
          properties: {
            deprecated: { type: "boolean" },
            replacement: { type: "string" },
            sunsetAt: { format: "date-time", type: "string" },
          },
          required: ["deprecated"],
          type: "object",
        },
        description: { type: "string" },
        examples: {
          items: {
            additionalProperties: false,
            properties: {
              description: { type: "string" },
              name: { minLength: 1, type: "string" },
              source: sourcePointerSchema,
              summary: { type: "string" },
              value: {},
            },
            required: ["name", "value"],
            type: "object",
          },
          type: "array",
        },
        extensions: { type: "object" },
        id: { minLength: 1, type: "string" },
        publicVersion: { minLength: 1, type: "string" },
        schema: {
          additionalProperties: false,
          properties: {
            checksum: { $ref: "#/$defs/checksum" },
            dialect: { minLength: 1, type: "string" },
            source: sourcePointerSchema,
            value: {
              oneOf: [{ type: "boolean" }, { type: "object" }],
            },
          },
          required: ["checksum", "dialect", "value"],
          type: "object",
        },
        signatureProfile: { $ref: "#/$defs/signatureProfile" },
        source: sourcePointerSchema,
        title: { type: "string" },
      },
      required: ["examples", "id", "publicVersion", "schema", "source"],
      type: "object",
    },
    location: {
      additionalProperties: false,
      properties: {
        column: { minimum: 1, type: "integer" },
        line: { minimum: 1, type: "integer" },
        offset: { minimum: 0, type: "integer" },
      },
      required: ["column", "line"],
      type: "object",
    },
    signatureProfile: {
      additionalProperties: false,
      properties: {
        algorithms: { items: { type: "string" }, type: "array" },
        extensions: { type: "object" },
        headers: {
          items: {
            additionalProperties: false,
            properties: {
              name: { minLength: 1, type: "string" },
              required: { type: "boolean" },
            },
            required: ["name", "required"],
            type: "object",
          },
          type: "array",
        },
        name: { minLength: 1, type: "string" },
        version: { type: "string" },
      },
      required: ["name"],
      type: "object",
    },
  },
  $id: CANONICAL_SCHEMA_ID,
  $schema: JSON_SCHEMA_2020_12_DIALECT,
  additionalProperties: false,
  properties: {
    $schema: { const: CANONICAL_SCHEMA_ID },
    checksum: { $ref: "#/$defs/checksum" },
    eventTypes: {
      items: { $ref: "#/$defs/eventType" },
      minItems: 1,
      type: "array",
    },
    extensions: { type: "object" },
    id: { minLength: 1, type: "string" },
    modelVersion: { const: CANONICAL_MODEL_VERSION },
    signatureProfile: { $ref: "#/$defs/signatureProfile" },
    source: {
      additionalProperties: false,
      properties: {
        extensions: { type: "object" },
        format: { enum: ["asyncapi", "openapi"] },
        mediaType: {
          enum: ["application/json", "application/yaml", "text/yaml"],
        },
        parser: {
          additionalProperties: false,
          properties: {
            name: { minLength: 1, type: "string" },
            version: { minLength: 1, type: "string" },
          },
          required: ["name", "version"],
          type: "object",
        },
        sourceChecksum: { $ref: "#/$defs/checksum" },
        sourceUri: { type: "string" },
        specificationVersion: { minLength: 1, type: "string" },
      },
      required: [
        "format",
        "mediaType",
        "parser",
        "sourceChecksum",
        "specificationVersion",
      ],
      type: "object",
    },
    title: { type: "string" },
    version: { type: "string" },
  },
  required: [
    "$schema",
    "checksum",
    "eventTypes",
    "id",
    "modelVersion",
    "source",
  ],
  type: "object",
};

export const CANONICAL_EXPORT_JSON_SCHEMA: JsonSchema = {
  $id: CANONICAL_EXPORT_SCHEMA_ID,
  $schema: JSON_SCHEMA_2020_12_DIALECT,
  additionalProperties: false,
  properties: {
    canonical: { $ref: CANONICAL_SCHEMA_ID },
    checksums: {
      additionalProperties: false,
      properties: {
        canonical: checksumSchema,
        source: checksumSchema,
      },
      required: ["canonical", "source"],
      type: "object",
    },
    format: { const: CANONICAL_EXPORT_FORMAT },
    formatVersion: { const: CANONICAL_EXPORT_VERSION },
    original: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            kind: { const: "text" },
            mediaType: {
              enum: ["application/json", "application/yaml", "text/yaml"],
            },
            value: { type: "string" },
          },
          required: ["kind", "mediaType", "value"],
          type: "object",
        },
        {
          additionalProperties: false,
          properties: {
            kind: { const: "document" },
            mediaType: {
              enum: ["application/json", "application/yaml", "text/yaml"],
            },
            value: { type: "object" },
          },
          required: ["kind", "mediaType", "value"],
          type: "object",
        },
      ],
    },
  },
  required: ["canonical", "checksums", "format", "formatVersion", "original"],
  type: "object",
};
