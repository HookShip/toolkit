// SPDX-License-Identifier: Apache-2.0

export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type JsonSchemaType =
  "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

/**
 * JSON Schema 2020-12 is intentionally open-ended. Known keywords are typed,
 * while unknown extension keywords must still be JSON-serializable.
 */
export interface JsonSchemaObject extends JsonObject {
  readonly $anchor?: string;
  readonly $comment?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly $dynamicAnchor?: string;
  readonly $dynamicRef?: string;
  readonly $id?: string;
  readonly $ref?: string;
  readonly $schema?: string;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly allOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly const?: JsonValue;
  readonly default?: JsonValue;
  readonly deprecated?: boolean;
  readonly description?: string;
  readonly else?: JsonSchema;
  readonly enum?: readonly JsonValue[];
  readonly example?: JsonValue;
  readonly examples?: readonly JsonValue[];
  readonly exclusiveMaximum?: number;
  readonly exclusiveMinimum?: number;
  readonly format?: string;
  readonly if?: JsonSchema;
  readonly items?: JsonSchema;
  readonly maxItems?: number;
  readonly maxLength?: number;
  readonly maxProperties?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly minProperties?: number;
  readonly minimum?: number;
  readonly multipleOf?: number;
  readonly not?: JsonSchema;
  readonly oneOf?: readonly JsonSchema[];
  readonly pattern?: string;
  readonly patternProperties?: Readonly<Record<string, JsonSchema>>;
  readonly prefixItems?: readonly JsonSchema[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly readOnly?: boolean;
  readonly required?: readonly string[];
  readonly then?: JsonSchema;
  readonly title?: string;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly unevaluatedItems?: boolean | JsonSchema;
  readonly unevaluatedProperties?: boolean | JsonSchema;
  readonly uniqueItems?: boolean;
  readonly writeOnly?: boolean;
}

export type JsonSchema = boolean | JsonSchemaObject;

export const UNSAFE_OBJECT_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
] as const;

const unsafeObjectKeys = new Set<string>(UNSAFE_OBJECT_KEYS);

export interface JsonGuardOptions {
  readonly allowUnsafeKeys?: boolean;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Checks JSON portability without invoking user-defined serialization hooks.
 * Cycles, non-finite numbers, exotic prototypes, and pollution-prone keys fail.
 */
export function isJsonValue(
  value: unknown,
  options: JsonGuardOptions = {},
): value is JsonValue {
  const maxDepth = options.maxDepth ?? 128;
  const maxNodes = options.maxNodes ?? 100_000;
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) {
      return false;
    }

    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return true;
    }

    if (typeof candidate === "number") {
      return Number.isFinite(candidate);
    }

    if (typeof candidate !== "object" || seen.has(candidate)) {
      return false;
    }

    seen.add(candidate);
    let valid = true;

    if (Array.isArray(candidate)) {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(descriptors);
      valid =
        keys.every(
          (key) =>
            key === "length" ||
            (typeof key === "string" && /^(?:0|[1-9]\d*)$/u.test(key)),
        ) && candidate.length <= maxNodes - nodes;
      for (let index = 0; valid && index < candidate.length; index += 1) {
        const descriptor = descriptors[String(index)];
        valid =
          descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable === true &&
          visit(descriptor.value, depth + 1);
      }
    } else if (isJsonObject(candidate)) {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      valid = Reflect.ownKeys(descriptors).every((key) => {
        if (typeof key !== "string") {
          return false;
        }
        const descriptor = descriptors[key];
        return (
          descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable === true &&
          (options.allowUnsafeKeys === true || !unsafeObjectKeys.has(key)) &&
          descriptor.value !== undefined &&
          visit(descriptor.value, depth + 1)
        );
      });
    } else {
      valid = false;
    }

    seen.delete(candidate);
    return valid;
  };

  return visit(value, 0);
}

export function isJsonSchema(value: unknown): value is JsonSchema {
  return (
    typeof value === "boolean" || (isJsonObject(value) && isJsonValue(value))
  );
}
