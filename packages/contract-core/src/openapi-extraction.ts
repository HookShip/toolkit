// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  isJsonSchema,
  type CanonicalExample,
  type JsonObject,
  type JsonSchema,
} from "@webhook-portal/canonical-model";

import { addExample, validateCanonicalExamples } from "./example-validation.js";
import {
  INTERPRETED_EVENT_EXTENSIONS,
  addAt,
  addExtractedEvent,
  readNonBlankString,
  resolveObject,
  resolveSchema,
  schemaDialect,
  selectedString,
  type ExtractedEvent,
  type ExtractionContext,
} from "./extraction-context.js";
import {
  asBoolean,
  asObject,
  asString,
  collectExtensions,
  compareCodeUnits,
  escapePointerToken,
  joinPointer,
} from "./json-utils.js";
import { inheritedSignature } from "./signature-profile.js";

const HTTP_METHODS = [
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "get",
  "trace",
] as const;

export function extractOpenApiExamples(
  media: JsonObject,
  schema: JsonSchema,
  mediaPointer: string,
  context: ExtractionContext,
): readonly CanonicalExample[] {
  const examples: CanonicalExample[] = [];
  if (media["example"] !== undefined) {
    addExample(
      examples,
      "default",
      media["example"],
      joinPointer(mediaPointer, "example"),
      context,
    );
  }

  const named = asObject(media["examples"]);
  if (named !== undefined) {
    for (const name of Object.keys(named).sort(compareCodeUnits)) {
      const pointer = joinPointer(joinPointer(mediaPointer, "examples"), name);
      const definition = resolveObject(
        named[name],
        pointer,
        context,
        "openapi-example",
      );
      if (definition === undefined) {
        continue;
      }
      if (typeof definition["externalValue"] === "string") {
        addAt(context, {
          code: "EXTERNAL_EXAMPLE_DENIED",
          message: "External example URLs are not fetched by contract-core",
          pointer: joinPointer(pointer, "externalValue"),
          severity: "error",
        });
      } else if (definition["value"] !== undefined) {
        addExample(
          examples,
          name,
          definition["value"],
          joinPointer(pointer, "value"),
          context,
          definition,
        );
      }
    }
  }

  if (isJsonObject(schema)) {
    if (schema["example"] !== undefined) {
      addExample(
        examples,
        "schema-example",
        schema["example"],
        joinPointer(mediaPointer, "schema/example"),
        context,
      );
    }
    if (Array.isArray(schema["examples"])) {
      schema["examples"].forEach((value, index) => {
        addExample(
          examples,
          `schema-example-${index + 1}`,
          value,
          joinPointer(mediaPointer, `schema/examples/${index}`),
          context,
        );
      });
    }
  }

  return examples.sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
}

export function jsonMediaType(content: JsonObject): string | undefined {
  return Object.keys(content)
    .sort(compareCodeUnits)
    .find((type) => isJsonMediaType(type));
}

export function isJsonMediaType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    (mediaType?.startsWith("application/") === true &&
      mediaType.endsWith("+json"))
  );
}

export function openApiEvents(
  document: JsonObject,
  context: ExtractionContext,
): readonly ExtractedEvent[] {
  const webhooks = asObject(document["webhooks"]);
  if (webhooks === undefined || Object.keys(webhooks).length === 0) {
    addAt(context, {
      code: "OPENAPI_WEBHOOKS_MISSING",
      message:
        "OpenAPI 3.1 document must define at least one top-level webhook",
      pointer: "/webhooks",
      severity: "error",
    });
    return [];
  }

  const info = asObject(document["info"]);
  const defaultVersion = asString(info?.["version"]) ?? "1";
  const events: ExtractedEvent[] = [];

  for (const webhookName of Object.keys(webhooks).sort(compareCodeUnits)) {
    if (context.validationBudget.exhausted || context.outputBudget.exhausted) {
      break;
    }
    const webhookPointer = `/webhooks/${escapePointerToken(webhookName)}`;
    const pathItem = resolveObject(
      webhooks[webhookName],
      webhookPointer,
      context,
      "openapi-path-item",
    );
    if (pathItem === undefined) {
      continue;
    }

    const methods = HTTP_METHODS.filter((method) =>
      isJsonObject(pathItem[method]),
    );
    if (methods.length === 0) {
      addAt(context, {
        code: "OPENAPI_WEBHOOK_OPERATION_MISSING",
        message: `Webhook "${webhookName}" has no HTTP operation`,
        pointer: webhookPointer,
        severity: "error",
      });
      continue;
    }
    if (methods.length > 1) {
      addAt(context, {
        code: "OPENAPI_MULTIPLE_WEBHOOK_OPERATIONS",
        message: `Webhook "${webhookName}" defines multiple operations; each is imported explicitly`,
        pointer: webhookPointer,
        severity: "warning",
      });
    }

    for (const method of methods) {
      if (
        context.validationBudget.exhausted ||
        context.outputBudget.exhausted
      ) {
        break;
      }
      const operationPointer = joinPointer(webhookPointer, method);
      const operation = resolveObject(
        pathItem[method],
        operationPointer,
        context,
        "openapi-operation",
      );
      if (operation === undefined) {
        continue;
      }
      if (!isJsonObject(operation["responses"])) {
        addAt(context, {
          code: "OPENAPI_WEBHOOK_RESPONSES_MISSING",
          message: `Webhook operation "${webhookName}.${method}" requires a responses object`,
          pointer: joinPointer(operationPointer, "responses"),
          severity: "error",
        });
        continue;
      }

      const requestBodyPointer = joinPointer(operationPointer, "requestBody");
      const requestBody = resolveObject(
        operation["requestBody"],
        requestBodyPointer,
        context,
        "openapi-request-body",
      );
      const contentPointer = joinPointer(requestBodyPointer, "content");
      const content = asObject(requestBody?.["content"]);
      const selectedMediaType =
        content === undefined ? undefined : jsonMediaType(content);
      if (content === undefined || selectedMediaType === undefined) {
        addAt(context, {
          code: "OPENAPI_JSON_PAYLOAD_MISSING",
          message: `Webhook "${webhookName}" has no JSON request body`,
          pointer: requestBodyPointer,
          severity: "error",
        });
        continue;
      }

      const mediaPointer = joinPointer(contentPointer, selectedMediaType);
      const media = resolveObject(
        content[selectedMediaType],
        mediaPointer,
        context,
        "direct",
      );
      if (media === undefined) {
        continue;
      }
      const schemaPointer = joinPointer(mediaPointer, "schema");
      const sourceSchemaDialect = schemaDialect(
        isJsonSchema(media["schema"]) ? media["schema"] : true,
        document,
        "openapi",
      );
      const resolvedSchema = resolveSchema(
        media["schema"],
        schemaPointer,
        context,
        sourceSchemaDialect,
      );
      if (resolvedSchema === undefined) {
        continue;
      }
      const schema = resolvedSchema.schema;

      const externalName = selectedString(
        readNonBlankString(
          operation,
          "x-event-type",
          operationPointer,
          context,
        ),
        readNonBlankString(pathItem, "x-event-type", webhookPointer, context),
        `${webhookName}.${method}`,
      );
      const publicVersion = selectedString(
        readNonBlankString(
          operation,
          "x-event-version",
          operationPointer,
          context,
        ),
        readNonBlankString(
          pathItem,
          "x-event-version",
          webhookPointer,
          context,
        ),
        defaultVersion,
      );
      const selectedIdentity = selectedString(
        readNonBlankString(operation, "x-event-id", operationPointer, context),
        readNonBlankString(pathItem, "x-event-id", webhookPointer, context),
        `openapi:${webhookPointer}:${method}`,
      );
      if (
        externalName === undefined ||
        publicVersion === undefined ||
        selectedIdentity === undefined
      ) {
        addAt(context, {
          code: "CANONICAL_EVENT_IDENTITY_INVALID",
          message:
            "Event name, public version, and source identity must be non-empty",
          pointer: operationPointer,
          severity: "error",
        });
        continue;
      }
      const examples = extractOpenApiExamples(
        media,
        schema,
        mediaPointer,
        context,
      );
      const dialect = schemaDialect(schema, document, "openapi");
      validateCanonicalExamples(
        schema,
        dialect,
        schemaPointer,
        resolvedSchema.bytes,
        resolvedSchema.nodes,
        examples,
        context,
      );

      const description = asString(operation["description"]);
      const extensions = collectExtensions(
        operation,
        INTERPRETED_EVENT_EXTENSIONS,
      );
      const operationSignature = inheritedSignature(
        operation,
        pathItem,
        document,
      );
      const title = asString(operation["summary"]);
      addExtractedEvent(
        events,
        {
          deprecated: asBoolean(operation["deprecated"]) ?? false,
          examples,
          externalName,
          publicVersion,
          schema,
          schemaDialect: dialect,
          schemaPointer,
          sourceIdentity: selectedIdentity,
          sourcePointer: operationPointer,
          ...(description === undefined ? {} : { description }),
          ...(extensions === undefined ? {} : { extensions }),
          ...(operationSignature === undefined
            ? {}
            : { signatureProfile: operationSignature }),
          ...(title === undefined ? {} : { title }),
        },
        context,
      );
    }
  }

  return events;
}
