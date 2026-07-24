// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  isJsonSchema,
  type CanonicalExample,
  type JsonObject,
  type JsonValue,
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
  jsonEqual,
} from "./json-utils.js";
import { isJsonMediaType } from "./openapi-extraction.js";
import { inheritedSignature } from "./signature-profile.js";
import { resolveAsyncApiSchemaDialect } from "./source-validation.js";

export function asyncApiExamples(
  message: JsonObject,
  messagePointer: string,
  context: ExtractionContext,
): readonly CanonicalExample[] {
  const examples: CanonicalExample[] = [];
  const source = message["examples"];
  if (Array.isArray(source)) {
    source.forEach((item, index) => {
      const pointer = joinPointer(
        joinPointer(messagePointer, "examples"),
        index,
      );
      if (isJsonObject(item) && item["payload"] !== undefined) {
        addExample(
          examples,
          asString(item["name"]) ?? `example-${index + 1}`,
          item["payload"],
          joinPointer(pointer, "payload"),
          context,
          item,
        );
      } else {
        addExample(examples, `example-${index + 1}`, item, pointer, context);
      }
    });
  }
  if (message["example"] !== undefined) {
    addExample(
      examples,
      "default",
      message["example"],
      joinPointer(messagePointer, "example"),
      context,
    );
  }
  return examples.sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
}

export function addAsyncMessage(
  messageValue: JsonValue,
  messagePointer: string,
  fallbackName: string,
  sourceIdentity: string,
  defaultVersion: string,
  document: JsonObject,
  events: ExtractedEvent[],
  context: ExtractionContext,
): void {
  if (context.outputBudget.exhausted) return;
  const message = resolveObject(
    messageValue,
    messagePointer,
    context,
    "asyncapi-message",
  );
  if (message === undefined) {
    return;
  }

  const asyncApiVersion = document["asyncapi"] === "2.6.0" ? "2.6.0" : "3.0.0";
  const declaredSchemaDialect = resolveAsyncApiSchemaDialect(
    message["schemaFormat"] ?? document["defaultSchemaFormat"],
    asyncApiVersion,
  );
  if (declaredSchemaDialect === undefined) {
    addAt(context, {
      code: "ASYNCAPI_SCHEMA_FORMAT_UNSUPPORTED",
      message: `AsyncAPI message uses unsupported schema format "${String(message["schemaFormat"])}"`,
      pointer: joinPointer(messagePointer, "schemaFormat"),
      severity: "error",
    });
    return;
  }
  const contentType =
    asString(message["contentType"]) ??
    asString(document["defaultContentType"]);
  if (contentType !== undefined && !isJsonMediaType(contentType)) {
    addAt(context, {
      code: "ASYNCAPI_MEDIA_TYPE_UNSUPPORTED",
      message: `AsyncAPI message media type "${contentType}" is not JSON`,
      pointer:
        asString(message["contentType"]) === undefined
          ? "/defaultContentType"
          : joinPointer(messagePointer, "contentType"),
      severity: "error",
    });
    return;
  }

  if (Array.isArray(message["oneOf"])) {
    message["oneOf"].forEach((item, index) => {
      addAsyncMessage(
        item,
        joinPointer(joinPointer(messagePointer, "oneOf"), index),
        `${fallbackName}.${index + 1}`,
        `${sourceIdentity}:oneOf:${index}`,
        defaultVersion,
        document,
        events,
        context,
      );
    });
    return;
  }

  const schemaPointer = joinPointer(messagePointer, "payload");
  const sourceSchemaDialect = schemaDialect(
    isJsonSchema(message["payload"]) ? message["payload"] : true,
    document,
    "asyncapi",
    declaredSchemaDialect,
  );
  const resolvedSchema = resolveSchema(
    message["payload"],
    schemaPointer,
    context,
    sourceSchemaDialect,
  );
  if (resolvedSchema === undefined) {
    return;
  }
  const schema = resolvedSchema.schema;
  const examples = asyncApiExamples(message, messagePointer, context);
  const dialect = schemaDialect(
    schema,
    document,
    "asyncapi",
    declaredSchemaDialect,
  );
  validateCanonicalExamples(
    schema,
    dialect,
    schemaPointer,
    resolvedSchema.bytes,
    resolvedSchema.nodes,
    examples,
    context,
  );

  const description = asString(message["description"]);
  const extensions = collectExtensions(message, INTERPRETED_EVENT_EXTENSIONS);
  const messageSignature = inheritedSignature(message, message, document);
  const title = asString(message["title"]);
  const extensionName = readNonBlankString(
    message,
    "x-event-type",
    messagePointer,
    context,
  );
  const messageName = readNonBlankString(
    message,
    "name",
    messagePointer,
    context,
    "CANONICAL_SOURCE_NAME_INVALID",
  );
  const messageId = readNonBlankString(
    message,
    "messageId",
    messagePointer,
    context,
    "CANONICAL_SOURCE_NAME_INVALID",
  );
  const eventVersion = readNonBlankString(
    message,
    "x-event-version",
    messagePointer,
    context,
  );
  const alternateVersion = readNonBlankString(
    message,
    "x-version",
    messagePointer,
    context,
  );
  const eventIdentity = readNonBlankString(
    message,
    "x-event-id",
    messagePointer,
    context,
  );
  if (
    !extensionName.valid ||
    !messageName.valid ||
    !messageId.valid ||
    !eventVersion.valid ||
    !alternateVersion.valid ||
    !eventIdentity.valid
  ) {
    return;
  }
  const externalName = extensionName.present
    ? extensionName.value
    : messageName.present
      ? messageName.value
      : messageId.present
        ? messageId.value
        : fallbackName.trim() === "" || fallbackName.trim() !== fallbackName
          ? undefined
          : fallbackName;
  const publicVersion = eventVersion.present
    ? eventVersion.value
    : alternateVersion.present
      ? alternateVersion.value
      : defaultVersion.trim() === "" || defaultVersion.trim() !== defaultVersion
        ? undefined
        : defaultVersion;
  const canonicalIdentity = eventIdentity.present
    ? eventIdentity.value
    : sourceIdentity.trim() === "" || sourceIdentity.trim() !== sourceIdentity
      ? undefined
      : sourceIdentity;
  if (
    externalName === undefined ||
    publicVersion === undefined ||
    canonicalIdentity === undefined
  ) {
    addAt(context, {
      code: "CANONICAL_EVENT_IDENTITY_INVALID",
      message:
        "Event name, public version, and source identity must be non-empty",
      pointer: messagePointer,
      severity: "error",
    });
    return;
  }
  addExtractedEvent(
    events,
    {
      deprecated: asBoolean(message["deprecated"]) ?? false,
      examples,
      externalName,
      publicVersion,
      schema,
      schemaDialect: dialect,
      schemaPointer,
      sourceIdentity: canonicalIdentity,
      sourcePointer: messagePointer,
      ...(description === undefined ? {} : { description }),
      ...(extensions === undefined ? {} : { extensions }),
      ...(messageSignature === undefined
        ? {}
        : { signatureProfile: messageSignature }),
      ...(title === undefined ? {} : { title }),
    },
    context,
  );
}

export function asyncApiEvents(
  document: JsonObject,
  version: string,
  context: ExtractionContext,
): readonly ExtractedEvent[] {
  const channels = asObject(document["channels"]);
  if (channels === undefined || Object.keys(channels).length === 0) {
    addAt(context, {
      code: "ASYNCAPI_CHANNELS_MISSING",
      message: "AsyncAPI document must define at least one channel",
      pointer: "/channels",
      severity: "error",
    });
    return [];
  }

  const info = asObject(document["info"]);
  const defaultVersion = asString(info?.["version"]) ?? "1";
  const events: ExtractedEvent[] = [];

  if (version.startsWith("2.6.")) {
    for (const channelName of Object.keys(channels).sort(compareCodeUnits)) {
      if (
        context.validationBudget.exhausted ||
        context.outputBudget.exhausted
      ) {
        break;
      }
      const channelPointer = `/channels/${escapePointerToken(channelName)}`;
      const channel = resolveObject(
        channels[channelName],
        channelPointer,
        context,
        "asyncapi-channel",
      );
      const operationPointer = joinPointer(channelPointer, "subscribe");
      const operation = resolveObject(
        channel?.["subscribe"],
        operationPointer,
        context,
        "asyncapi-operation",
      );
      if (operation?.["message"] === undefined) {
        continue;
      }
      addAsyncMessage(
        operation["message"],
        joinPointer(operationPointer, "message"),
        channelName,
        `asyncapi2:${channelPointer}:subscribe`,
        defaultVersion,
        document,
        events,
        context,
      );
    }
  } else {
    const operations = asObject(document["operations"]);
    if (operations !== undefined) {
      for (const operationName of Object.keys(operations).sort(
        compareCodeUnits,
      )) {
        if (
          context.validationBudget.exhausted ||
          context.outputBudget.exhausted
        ) {
          break;
        }
        const operationPointer = `/operations/${escapePointerToken(operationName)}`;
        const operation = resolveObject(
          operations[operationName],
          operationPointer,
          context,
          "asyncapi-operation",
        );
        if (operation?.["action"] !== "send") {
          continue;
        }
        const channelPointer = joinPointer(operationPointer, "channel");
        const channel =
          operation["channel"] === undefined
            ? undefined
            : resolveObject(
                operation["channel"],
                channelPointer,
                context,
                "asyncapi-channel",
              );
        if (channel === undefined) {
          addAt(context, {
            code: "ASYNCAPI_SEND_CHANNEL_MISSING",
            message: `Send operation "${operationName}" must reference a channel`,
            pointer: channelPointer,
            severity: "error",
          });
          continue;
        }
        const channelMessages = asObject(channel["messages"]);
        if (
          channelMessages === undefined ||
          Object.keys(channelMessages).length === 0
        ) {
          addAt(context, {
            code: "ASYNCAPI_CHANNEL_MESSAGES_MISSING",
            message: `Send operation "${operationName}" references a channel without messages`,
            pointer: joinPointer(channelPointer, "messages"),
            severity: "error",
          });
          continue;
        }

        const availableMessages = Object.keys(channelMessages)
          .sort(compareCodeUnits)
          .flatMap((name) => {
            const pointer = joinPointer(
              joinPointer(channelPointer, "messages"),
              name,
            );
            const raw = channelMessages[name];
            const resolved =
              raw === undefined
                ? undefined
                : resolveObject(raw, pointer, context, "asyncapi-message");
            return raw === undefined || resolved === undefined
              ? []
              : [{ name, pointer, raw, resolved }];
          });
        const requested = operation["messages"];
        const selected:
          | readonly {
              readonly identity: string;
              readonly pointer: string;
              readonly raw: JsonValue;
            }[]
          | undefined =
          requested === undefined
            ? availableMessages.map(({ name, pointer, raw }) => ({
                identity: `asyncapi3:${channelPointer}:message:${name}`,
                pointer,
                raw,
              }))
            : Array.isArray(requested)
              ? requested.flatMap((message, index) => {
                  const pointer = joinPointer(
                    joinPointer(operationPointer, "messages"),
                    index,
                  );
                  const resolved = resolveObject(
                    message,
                    pointer,
                    context,
                    "asyncapi-message",
                  );
                  const match =
                    resolved === undefined
                      ? undefined
                      : availableMessages.find(({ resolved: candidate }) =>
                          jsonEqual(candidate, resolved),
                        );
                  if (match === undefined) {
                    addAt(context, {
                      code: "ASYNCAPI_SEND_MESSAGE_NOT_IN_CHANNEL",
                      message: `Send operation "${operationName}" references a message outside its channel`,
                      pointer,
                      severity: "error",
                    });
                    return [];
                  }
                  return [
                    {
                      identity:
                        isJsonObject(message) &&
                        typeof message["$ref"] === "string"
                          ? `asyncapi3:${message["$ref"]}`
                          : `asyncapi3:${channelPointer}:message:${match.name}`,
                      pointer,
                      raw: message,
                    },
                  ];
                })
              : undefined;
        if (selected === undefined || selected.length === 0) {
          addAt(context, {
            code: "ASYNCAPI_SEND_MESSAGES_MISSING",
            message: `Send operation "${operationName}" has no usable channel messages`,
            pointer: joinPointer(operationPointer, "messages"),
            severity: "error",
          });
          continue;
        }
        selected.forEach(({ identity, pointer, raw }) => {
          addAsyncMessage(
            raw,
            pointer,
            operationName,
            identity,
            defaultVersion,
            document,
            events,
            context,
          );
        });
      }
    }
  }

  if (events.length === 0) {
    addAt(context, {
      code: "ASYNCAPI_OUTBOUND_MESSAGES_MISSING",
      message: "No outbound producer messages were found",
      pointer: version.startsWith("2.6.") ? "/channels" : "/operations",
      severity: "error",
    });
  }
  return events;
}
