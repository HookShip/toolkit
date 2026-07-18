// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { type ContractOptions, type JsonObject } from "../src/index.js";
import { DiagnosticCollector } from "../src/diagnostics.js";
import { DEFAULT_CONTRACT_LIMITS } from "../src/limits.js";
import {
  resolveObjectValue,
  type ReferenceContext,
  type ReferenceObjectKind,
} from "../src/refs.js";

const unsupportedRemoteOptions: ContractOptions = {
  // @ts-expect-error External reference resolvers are intentionally not public.
  remoteReferences: { documents: {} },
};
void unsupportedRemoteOptions;

const root: JsonObject = {
  channels: {
    Channel: {
      messages: { Message: { name: "message", payload: { type: "object" } } },
      subscribe: {
        message: { name: "message", payload: { type: "object" } },
      },
    },
  },
  components: {
    channels: {
      Channel: {
        messages: {},
        "x-holder": { channel: { messages: {} } },
      },
    },
    examples: { Example: { value: { ok: true } } },
    messages: {
      Message: {
        examples: [{ payload: { type: "object" } }],
        name: "message",
        payload: { type: "object" },
      },
    },
    operations: {
      Operation: {
        action: "send",
        channel: {},
        "x-holder": { operation: { action: "send", channel: {} } },
      },
    },
    pathItems: {
      Path: {
        post: {},
        "x-holder": {
          pathItem: { post: {} },
          requestBody: { content: {} },
        },
      },
    },
    requestBodies: { Body: { content: {} } },
  },
  operations: { Operation: { action: "send", channel: {} } },
};

interface MatrixCase {
  readonly format: "asyncapi" | "openapi";
  readonly kind: ReferenceObjectKind;
  readonly pointer: string;
  readonly version: string;
}

function resolve(entry: MatrixCase): {
  readonly diagnostics: DiagnosticCollector;
  readonly value: JsonObject | undefined;
} {
  const diagnostics = new DiagnosticCollector(10);
  const context: ReferenceContext = {
    diagnostics,
    documentId: "local",
    limits: DEFAULT_CONTRACT_LIMITS,
    locations: {},
    referenceBudget: { count: 0, exceeded: false, seen: new Set() },
    root,
    sourceFormat: entry.format,
    specificationVersion: entry.version,
  };
  return {
    diagnostics,
    value: resolveObjectValue(
      { $ref: `#${entry.pointer}` },
      "/probe",
      context,
      entry.kind,
    ),
  };
}

const positives: readonly MatrixCase[] = [
  {
    format: "openapi",
    kind: "openapi-path-item",
    pointer: "/components/pathItems/Path",
    version: "3.1.0",
  },
  {
    format: "openapi",
    kind: "openapi-request-body",
    pointer: "/components/requestBodies/Body",
    version: "3.1.0",
  },
  {
    format: "openapi",
    kind: "openapi-example",
    pointer: "/components/examples/Example",
    version: "3.1.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-message",
    pointer: "/components/messages/Message",
    version: "2.6.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-message",
    pointer: "/channels/Channel/subscribe/message",
    version: "2.6.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-channel",
    pointer: "/channels/Channel",
    version: "2.6.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-operation",
    pointer: "/channels/Channel/subscribe",
    version: "2.6.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-message",
    pointer: "/components/messages/Message",
    version: "3.0.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-message",
    pointer: "/channels/Channel/messages/Message",
    version: "3.0.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-channel",
    pointer: "/channels/Channel",
    version: "3.0.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-channel",
    pointer: "/components/channels/Channel",
    version: "3.0.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-operation",
    pointer: "/operations/Operation",
    version: "3.0.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-operation",
    pointer: "/components/operations/Operation",
    version: "3.0.0",
  },
];

const negatives: readonly MatrixCase[] = [
  {
    format: "openapi",
    kind: "openapi-request-body",
    pointer: "/components/pathItems/Path/x-holder/requestBody",
    version: "3.1.0",
  },
  {
    format: "openapi",
    kind: "openapi-path-item",
    pointer: "/components/pathItems/Path/x-holder/pathItem",
    version: "3.1.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-channel",
    pointer: "/components/channels/Channel",
    version: "2.6.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-operation",
    pointer: "/components/operations/Operation",
    version: "2.6.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-message",
    pointer: "/channels/Channel/messages/Message",
    version: "2.6.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-message",
    pointer: "/channels/Channel/subscribe/message",
    version: "3.0.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-message",
    pointer: "/components/messages/Message/examples/0",
    version: "3.0.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-channel",
    pointer: "/components/channels/Channel/x-holder/channel",
    version: "3.0.0",
  },
  {
    format: "asyncapi",
    kind: "asyncapi-operation",
    pointer: "/components/operations/Operation/x-holder/operation",
    version: "3.0.0",
  },
];

describe("official typed Reference Object target matrix", () => {
  for (const entry of positives) {
    it(`accepts ${entry.version} ${entry.kind} ${entry.pointer}`, () => {
      const result = resolve(entry);
      expect(result.value).toBeDefined();
      expect(result.diagnostics.toArray()).toEqual([]);
    });
  }

  for (const entry of negatives) {
    it(`rejects ${entry.version} ${entry.kind} ${entry.pointer}`, () => {
      const result = resolve(entry);
      expect(result.value).toBeUndefined();
      expect(result.diagnostics.toArray()).toContainEqual(
        expect.objectContaining({ code: "REF_TARGET_KIND_MISMATCH" }),
      );
    });
  }

  for (const entry of positives) {
    for (const [label, reference] of [
      ["external", `https://refs.example.test/document.json#${entry.pointer}`],
      ["relative", `./document.json#${entry.pointer}`],
    ] as const) {
      it(`rejects ${label} ${entry.version} ${entry.kind}`, () => {
        const diagnostics = new DiagnosticCollector(10);
        const context: ReferenceContext = {
          diagnostics,
          documentId: "local",
          limits: DEFAULT_CONTRACT_LIMITS,
          locations: {},
          referenceBudget: { count: 0, exceeded: false, seen: new Set() },
          root,
          sourceFormat: entry.format,
          specificationVersion: entry.version,
        };
        expect(
          resolveObjectValue(
            { $ref: reference },
            "/probe",
            context,
            entry.kind,
          ),
        ).toBeUndefined();
        expect(diagnostics.toArray()).toContainEqual(
          expect.objectContaining({ code: "TYPED_EXTERNAL_REF_UNSUPPORTED" }),
        );
      });
    }
  }
});
