// Covers plugin config schema validation and diagnostics.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildJsonPluginConfigSchema,
  buildPluginConfigSchema,
  emptyPluginConfigSchema,
} from "./config-schema.js";

function expectSafeParseCases(
  safeParse: ((value: unknown) => unknown) | undefined,
  cases: ReadonlyArray<readonly [unknown, unknown]>,
) {
  if (safeParse === undefined) {
    throw new Error("expected config schema safeParse function");
  }
  expect(cases.map(([value]) => safeParse(value))).toEqual(cases.map(([, expected]) => expected));
}

function expectJsonSchema(
  result: ReturnType<typeof buildPluginConfigSchema>,
  expected: Record<string, unknown>,
) {
  expect(result.jsonSchema).toEqual(expected);
}

describe("buildPluginConfigSchema", () => {
  it("builds json schema when toJSONSchema is available", () => {
    const schema = z.strictObject({ enabled: z.boolean().default(true) });
    const result = buildPluginConfigSchema(schema);
    expectJsonSchema(result, {
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean", default: true } },
    });
  });

  it("uses input mode and strips helper-only draft metadata", () => {
    const toJSONSchema = vi.fn(() => ({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      propertyNames: { type: "string" },
      required: [],
      properties: {
        enabled: { type: "boolean", default: true },
      },
    }));
    const schema = { toJSONSchema } as unknown as Parameters<typeof buildPluginConfigSchema>[0];

    const result = buildPluginConfigSchema(schema);

    expect(toJSONSchema).toHaveBeenCalledWith({
      target: "draft-07",
      io: "input",
      unrepresentable: "any",
    });
    expect(result.jsonSchema).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
      },
    });
  });

  it("keeps the schema receiver when exporting JSON schema metadata", () => {
    const schema = {
      propertyName: "enabled",
      toJSONSchema(
        this: { propertyName: string },
        _params?: Record<string, unknown>,
      ): Record<string, unknown> {
        return {
          type: "object",
          properties: {
            [this.propertyName]: { type: "boolean" },
          },
        };
      },
    };

    const result = buildPluginConfigSchema(
      schema as unknown as Parameters<typeof buildPluginConfigSchema>[0],
    );

    expect(result.jsonSchema).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
    });
  });

  it("falls back when toJSONSchema is missing", () => {
    const legacySchema = {} as unknown as Parameters<typeof buildPluginConfigSchema>[0];
    const result = buildPluginConfigSchema(legacySchema);
    expectJsonSchema(result, { type: "object", additionalProperties: true });
  });

  it("falls back when toJSONSchema metadata is unreadable", () => {
    const schema = {} as Record<string, unknown>;
    Object.defineProperty(schema, "toJSONSchema", {
      enumerable: true,
      get() {
        throw new Error("toJSONSchema getter failed");
      },
    });

    const result = buildPluginConfigSchema(
      schema as unknown as Parameters<typeof buildPluginConfigSchema>[0],
    );

    expectJsonSchema(result, { type: "object", additionalProperties: true });
  });

  it("uses zod runtime parsing by default", () => {
    const result = buildPluginConfigSchema(z.strictObject({ enabled: z.boolean().default(true) }));
    expect(result.safeParse?.({})).toEqual({
      success: true,
      data: { enabled: true },
    });
  });

  it("allows custom safeParse overrides", () => {
    const safeParse = vi.fn(() => ({ success: true as const, data: { normalized: true } }));
    const result = buildPluginConfigSchema(z.strictObject({ enabled: z.boolean().optional() }), {
      safeParse,
    });

    expect(result.safeParse?.({ enabled: false })).toEqual({
      success: true,
      data: { normalized: true },
    });
    expect(safeParse).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("buildJsonPluginConfigSchema", () => {
  it("validates direct JSON schemas without zod conversion", () => {
    const result = buildJsonPluginConfigSchema(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", default: true },
        },
      },
      { cacheKey: "config-schema.test.json-plugin" },
    );

    expect(result.jsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
      },
    });
    expect(result.safeParse?.({})).toEqual({
      success: true,
      data: { enabled: true },
    });
    expect(result.safeParse?.({ enabled: "yes" })).toEqual({
      success: false,
      error: { issues: [{ path: ["enabled"], message: "must be boolean" }] },
    });
  });

  it("keeps numeric-looking object keys outside array-index range as strings", () => {
    const result = buildJsonPluginConfigSchema(
      {
        type: "object",
        required: ["100001"],
        properties: {
          "100001": { type: "boolean" },
        },
      },
      { cacheKey: "config-schema.test.large-numeric-key" },
    );

    expect(result.safeParse?.({})).toEqual({
      success: false,
      error: {
        issues: [{ path: ["100001"], message: "must have required property '100001'" }],
      },
    });
  });

  it("keeps runtime-only property name constraints during validation", () => {
    const result = buildJsonPluginConfigSchema(
      {
        type: "object",
        propertyNames: { type: "string", pattern: "^[a-z]+$" },
        additionalProperties: true,
      },
      { cacheKey: "config-schema.test.property-names" },
    );

    expect(result.jsonSchema).toEqual({
      type: "object",
      additionalProperties: true,
    });
    expect(result.safeParse?.({ valid: 1 })).toEqual({
      success: true,
      data: { valid: 1 },
    });
    const invalid = result.safeParse?.({ INVALID: 1 });
    expect(invalid).toMatchObject({ success: false });
  });

  it("skips unreadable JSON schema fields before config validation", () => {
    const properties: Record<string, unknown> = {
      enabled: { type: "boolean" },
    };
    Object.defineProperty(properties, "broken", {
      enumerable: true,
      get() {
        throw new Error("property schema getter failed");
      },
    });
    const result = buildJsonPluginConfigSchema(
      {
        type: "object",
        additionalProperties: false,
        properties,
      },
      { cacheKey: "config-schema.test.unreadable-field" },
    );

    expect(result.jsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
      },
    });
    expect(result.safeParse?.({ enabled: true })).toEqual({
      success: true,
      data: { enabled: true },
    });
  });
});

describe("emptyPluginConfigSchema", () => {
  it("accepts undefined and empty objects only", () => {
    const schema = emptyPluginConfigSchema();
    expectSafeParseCases(schema.safeParse, [
      [undefined, { success: true, data: undefined }],
      [{}, { success: true, data: {} }],
      [
        { nope: true },
        { success: false, error: { issues: [{ path: [], message: "config must be empty" }] } },
      ],
    ] as const);
  });
});
