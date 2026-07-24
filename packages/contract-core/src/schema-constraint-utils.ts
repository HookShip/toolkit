// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  isJsonSchema,
  type JsonSchema,
  type JsonValue,
} from "@webhook-portal/canonical-model";

import { compareCodeUnits, sortJsonValue } from "./json-utils.js";
import {
  SCHEMA_ARRAY_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_SINGLE_KEYWORDS,
} from "./schema-keywords.js";

export function stripRegexConstraintsForValidation(
  schema: JsonSchema,
): JsonSchema {
  if (typeof schema === "boolean") {
    return schema;
  }
  const result: Record<string, JsonValue> = {};
  let removedPatternProperties = false;
  for (const key of Object.keys(schema).sort(compareCodeUnits)) {
    const item = schema[key];
    if (item === undefined || key === "pattern") {
      continue;
    }
    if (key === "patternProperties") {
      removedPatternProperties = true;
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
      const map: Record<string, JsonValue> = {};
      for (const name of Object.keys(item).sort(compareCodeUnits)) {
        const child = item[name];
        if (isJsonSchema(child)) {
          map[name] = stripRegexConstraintsForValidation(child);
        }
      }
      result[key] = map;
    } else if (
      (SCHEMA_ARRAY_KEYWORDS.has(key) || key === "items") &&
      Array.isArray(item)
    ) {
      result[key] = item.map((child) =>
        isJsonSchema(child)
          ? stripRegexConstraintsForValidation(child)
          : sortJsonValue(child),
      );
    } else if (SCHEMA_SINGLE_KEYWORDS.has(key) && isJsonSchema(item)) {
      result[key] = stripRegexConstraintsForValidation(item);
    } else {
      result[key] = sortJsonValue(item);
    }
  }
  if (removedPatternProperties) {
    result["additionalProperties"] = true;
    result["unevaluatedProperties"] = true;
  }
  return result;
}

/**
 * Removes uniqueItems before validating examples when its quadratic worst case
 * would exceed the synchronous validation budget.
 */
export function stripUniqueItemsForValidation(schema: JsonSchema): JsonSchema {
  if (typeof schema === "boolean") {
    return schema;
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(schema).sort(compareCodeUnits)) {
    const item = schema[key];
    if (item === undefined || (key === "uniqueItems" && item === true)) {
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
      const map: Record<string, JsonValue> = {};
      for (const name of Object.keys(item).sort(compareCodeUnits)) {
        const child = item[name];
        if (isJsonSchema(child)) {
          map[name] = stripUniqueItemsForValidation(child);
        }
      }
      result[key] = map;
    } else if (
      (SCHEMA_ARRAY_KEYWORDS.has(key) || key === "items") &&
      Array.isArray(item)
    ) {
      result[key] = item.map((child) =>
        isJsonSchema(child)
          ? stripUniqueItemsForValidation(child)
          : sortJsonValue(child),
      );
    } else if (SCHEMA_SINGLE_KEYWORDS.has(key) && isJsonSchema(item)) {
      result[key] = stripUniqueItemsForValidation(item);
    } else {
      result[key] = sortJsonValue(item);
    }
  }
  return result;
}

export function countRegexConstraints(schema: JsonSchema): number {
  if (typeof schema === "boolean") {
    return 0;
  }
  let count = typeof schema["pattern"] === "string" ? 1 : 0;
  const patternProperties = schema["patternProperties"];
  if (isJsonObject(patternProperties)) {
    count += Object.keys(patternProperties).length;
    for (const child of Object.values(patternProperties)) {
      if (isJsonSchema(child)) {
        count += countRegexConstraints(child);
      }
    }
  }
  for (const key of SCHEMA_MAP_KEYWORDS) {
    if (key === "patternProperties") {
      continue;
    }
    const map = schema[key];
    if (isJsonObject(map)) {
      for (const child of Object.values(map)) {
        if (isJsonSchema(child)) {
          count += countRegexConstraints(child);
        }
      }
    }
  }
  for (const key of [...SCHEMA_ARRAY_KEYWORDS, "items"]) {
    const values = schema[key];
    if (Array.isArray(values)) {
      for (const child of values) {
        if (isJsonSchema(child)) {
          count += countRegexConstraints(child);
        }
      }
    }
  }
  for (const key of SCHEMA_SINGLE_KEYWORDS) {
    const child = schema[key];
    if (isJsonSchema(child)) {
      count += countRegexConstraints(child);
    }
  }
  return count;
}

export function countUniqueItemsConstraints(schema: JsonSchema): number {
  if (typeof schema === "boolean") {
    return 0;
  }
  let count = schema["uniqueItems"] === true ? 1 : 0;
  for (const key of SCHEMA_MAP_KEYWORDS) {
    const map = schema[key];
    if (isJsonObject(map)) {
      for (const child of Object.values(map)) {
        if (isJsonSchema(child)) {
          count += countUniqueItemsConstraints(child);
        }
      }
    }
  }
  for (const key of [...SCHEMA_ARRAY_KEYWORDS, "items"]) {
    const values = schema[key];
    if (Array.isArray(values)) {
      for (const child of values) {
        if (isJsonSchema(child)) {
          count += countUniqueItemsConstraints(child);
        }
      }
    }
  }
  for (const key of SCHEMA_SINGLE_KEYWORDS) {
    const child = schema[key];
    if (isJsonSchema(child)) {
      count += countUniqueItemsConstraints(child);
    }
  }
  return count;
}
