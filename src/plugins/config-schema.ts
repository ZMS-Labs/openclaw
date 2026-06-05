// Builds plugin config schemas from manifest metadata.
import { z, type ZodTypeAny } from "zod";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import type { PluginConfigUiHint } from "./manifest-types.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type { OpenClawPluginConfigSchema } from "./types.js";

type Issue = { path: Array<string | number>; message: string };

type SafeParseResult =
  | { success: true; data?: unknown }
  | { success: false; error: { issues: Issue[] } };

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

type BuildPluginConfigSchemaOptions = {
  uiHints?: Record<string, PluginConfigUiHint>;
  safeParse?: OpenClawPluginConfigSchema["safeParse"];
};

type BuildJsonPluginConfigSchemaOptions = {
  cacheKey?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
  safeParse?: OpenClawPluginConfigSchema["safeParse"];
};

function error(message: string): SafeParseResult {
  return { success: false, error: { issues: [{ path: [], message }] } };
}

function cloneIssue(issue: z.ZodIssue): Issue {
  return {
    path: issue.path.filter((segment): segment is string | number => {
      const kind = typeof segment;
      return kind === "string" || kind === "number";
    }),
    message: issue.message,
  };
}

function safeParseRuntimeSchema(schema: ZodTypeAny, value: unknown): SafeParseResult {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }
  return {
    success: false,
    error: { issues: result.error.issues.map((issue) => cloneIssue(issue)) },
  };
}

function snapshotJsonSchema(schema: unknown, options?: { stripUiOnlyMetadata?: boolean }): unknown {
  if (Array.isArray(schema)) {
    const items: unknown[] = [];
    for (const index of schema.keys()) {
      try {
        items.push(snapshotJsonSchema(schema[index], options));
      } catch {
        // Plugin-owned schemas are UI metadata; skip unreadable array entries
        // so config/schema discovery cannot crash the gateway.
      }
    }
    return items;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    try {
      record[key] = snapshotJsonSchema((schema as Record<string, unknown>)[key], options);
    } catch {
      // Skip hostile accessors while preserving the rest of the schema object.
    }
  }
  if (!options?.stripUiOnlyMetadata) {
    return record;
  }

  delete record.$schema;
  const propertyNames = record.propertyNames;
  if (
    propertyNames &&
    typeof propertyNames === "object" &&
    !Array.isArray(propertyNames) &&
    (propertyNames as Record<string, unknown>).type === "string"
  ) {
    delete record.propertyNames;
  }

  if (Array.isArray(record.required) && record.required.length === 0) {
    delete record.required;
  }

  return record;
}

function normalizeJsonSchema(schema: unknown): unknown {
  return snapshotJsonSchema(schema, { stripUiOnlyMetadata: true });
}

function toIssuePath(path: string): Array<string | number> {
  if (!path || path === "<root>") {
    return [];
  }
  return path.split(".").map((segment) => {
    return parseConfigPathArrayIndex(segment) ?? segment;
  });
}

function safeParseJsonSchema(
  schema: JsonSchemaObject,
  cacheKey: string,
  value: unknown,
): SafeParseResult {
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value,
    applyDefaults: true,
  });
  if (result.ok) {
    return { success: true, data: result.value };
  }
  return {
    success: false,
    error: {
      issues: result.errors.map((issue) => ({
        path: toIssuePath(issue.path),
        message: issue.message,
      })),
    },
  };
}

/** Build a plugin config schema from JSON Schema with runtime validation/default support. */
export function buildJsonPluginConfigSchema(
  schema: JsonSchemaObject,
  options?: BuildJsonPluginConfigSchemaOptions,
): OpenClawPluginConfigSchema {
  const runtimeSchema = snapshotJsonSchema(schema) as JsonSchemaObject;
  const jsonSchema = normalizeJsonSchema(schema) as JsonSchemaObject;
  const safeParse =
    options?.safeParse ??
    ((value: unknown) =>
      safeParseJsonSchema(runtimeSchema, options?.cacheKey ?? "plugin-config-schema:json", value));
  return {
    safeParse,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    jsonSchema,
  };
}

/** Build a plugin config schema from Zod, exporting JSON Schema when the Zod runtime supports it. */
export function buildPluginConfigSchema(
  schema: ZodTypeAny,
  options?: BuildPluginConfigSchemaOptions,
): OpenClawPluginConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  const safeParse = options?.safeParse ?? ((value) => safeParseRuntimeSchema(schema, value));
  let toJSONSchema: ZodSchemaWithToJsonSchema["toJSONSchema"];
  try {
    toJSONSchema = schemaWithJson.toJSONSchema;
  } catch {
    toJSONSchema = undefined;
  }
  if (typeof toJSONSchema === "function") {
    try {
      return {
        safeParse,
        ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
        // Normalize generated schema so plugin consumers see a stable draft-07-ish shape.
        jsonSchema: normalizeJsonSchema(
          toJSONSchema.call(schemaWithJson, {
            target: "draft-07",
            io: "input",
            unrepresentable: "any",
          }),
        ) as JsonSchemaObject,
      };
    } catch {
      // Fall through to the permissive metadata schema. Runtime parsing still
      // uses the original Zod schema when available.
    }
  }

  return {
    safeParse,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    jsonSchema: {
      type: "object",
      additionalProperties: true,
    },
  };
}

/** Return a schema for plugins that intentionally accept no config keys. */
export function emptyPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown): SafeParseResult {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return error("expected config object");
      }
      if (Object.keys(value as Record<string, unknown>).length > 0) {
        return error("config must be empty");
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}
