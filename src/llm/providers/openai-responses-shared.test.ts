// OpenAI Responses shared tests cover tool conversion and response item mapping.
import type { Tool as OpenAIResponsesTool } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { Context, Model, Tool } from "../types.js";
import {
  applyCommonResponsesParams,
  convertResponsesMessages,
  createResponsesAssistantOutput,
  resolveResponsesReasoningEffort,
} from "./openai-responses-shared.js";
import { convertResponsesTools } from "./openai-responses-tools.js";

type ResponsesFunctionTool = Extract<OpenAIResponsesTool, { type: "function" }>;

function expectResponsesFunctionTool(tool: OpenAIResponsesTool | undefined): ResponsesFunctionTool {
  expect(tool).toHaveProperty("type", "function");
  return tool as ResponsesFunctionTool;
}

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const proxyOpenAIModel = {
  ...nativeOpenAIModel,
  id: "custom-model",
  name: "Custom Model",
  baseUrl: "https://proxy.example.com/v1",
} satisfies Model<"openai-responses">;

describe("convertResponsesTools", () => {
  it("enables native strict OpenAI Responses tools and normalizes schemas", () => {
    const tools = [
      {
        name: "lookup_weather",
        description: "Get forecast",
        parameters: {},
      },
    ] satisfies Tool[];

    const converted = convertResponsesTools(tools, { model: nativeOpenAIModel });

    expect(converted).toEqual([
      {
        type: "function",
        name: "lookup_weather",
        description: "Get forecast",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("downgrades incompatible native Responses schemas to strict false", () => {
    const converted = convertResponsesTools(
      [
        {
          name: "read_file",
          description: "Read",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: [],
          },
        },
      ],
      { model: nativeOpenAIModel },
    );

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool.strict).toBe(false);
    expect(tool.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: [],
    });
  });

  it("omits strict on proxy-like Responses routes but keeps schema normalization", () => {
    const converted = convertResponsesTools(
      [
        {
          name: "lookup_weather",
          description: "Get forecast",
          parameters: {},
        },
      ],
      { model: proxyOpenAIModel },
    );

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool).not.toHaveProperty("strict");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("keeps tool order deterministic", () => {
    const zeta = {
      name: "zeta",
      description: "Z",
      parameters: {},
    } satisfies Tool;
    const alpha = {
      name: "alpha",
      description: "A",
      parameters: {},
    } satisfies Tool;

    expect(
      convertResponsesTools([zeta, alpha]).map((tool) => expectResponsesFunctionTool(tool).name),
    ).toEqual(["alpha", "zeta"]);
  });

  it("skips unreadable tool metadata without dropping healthy Responses tools", () => {
    const poisoned = {
      name: "dofbot_move_angles",
      description: "Broken experimental tool",
      parameters: {},
    };
    Object.defineProperty(poisoned, "parameters", {
      enumerable: true,
      get() {
        throw new Error("dofbot schema getter exploded");
      },
    });
    const healthy = {
      name: "lookup_weather",
      description: "Get forecast",
      parameters: {},
    } satisfies Tool;

    const converted = convertResponsesTools([poisoned as Tool, healthy], {
      model: nativeOpenAIModel,
    });

    expect(converted).toHaveLength(1);
    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool.name).toBe("lookup_weather");
    expect(tool.strict).toBe(true);
  });

  it("keeps healthy tools strict when strict-schema traversal skips hostile metadata", () => {
    const poisonedParameters = { type: "object" };
    Object.defineProperty(poisonedParameters, "properties", {
      enumerable: true,
      get() {
        throw new Error("properties revoked");
      },
    });
    const poisoned = {
      name: "dofbot_move_angles",
      description: "Broken experimental tool",
      parameters: poisonedParameters,
    } satisfies Tool;
    const healthy = {
      name: "lookup_weather",
      description: "Get forecast",
      parameters: {},
    } satisfies Tool;

    const converted = convertResponsesTools([poisoned, healthy], { model: nativeOpenAIModel });

    expect(converted).toHaveLength(1);
    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool.name).toBe("lookup_weather");
    expect(tool.strict).toBe(true);
  });
});

describe("convertResponsesMessages", () => {
  const allowedToolCallProviders = new Set(["openai", "openai-codex", "opencode"]);

  it("omits phase-tagged assistant replay ids without reasoning", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "text",
                text: "Working...",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_commentary",
                  phase: "commentary",
                }),
              },
            ],
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "phase" in item &&
          item.phase === "commentary",
      ),
    ).toMatchObject({
      phase: "commentary",
    });
    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "phase" in item &&
          item.phase === "commentary",
      ),
    ).not.toHaveProperty("id");
  });

  it("omits raw signed assistant ids when the paired reasoning item is absent", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "text",
                text: "Earlier answer",
                textSignature: "msg_real_response_item_requiring_reasoning",
              },
            ],
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "content" in item,
      ),
    ).not.toHaveProperty("id");
  });

  it("omits Responses replay item ids when requested by store-disabled callers", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking the price.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "price_lookup",
                arguments: { symbol: "SOL" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_abc|fc_prior",
            toolName: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false, replayResponsesItemIds: false },
    ) as unknown as Array<Record<string, unknown>>;

    const reasoningItem = input.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem).not.toHaveProperty("id");

    const assistantMessage = input.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expect(assistantMessage).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage).not.toHaveProperty("id");

    const functionCall = input.find((item) => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall).not.toHaveProperty("id");
  });

  it("ignores unreadable model metadata while converting Responses messages", () => {
    const model = Object.defineProperties(
      { ...nativeOpenAIModel },
      {
        id: {
          get() {
            throw new Error("id getter should be caught");
          },
        },
        provider: {
          get() {
            throw new Error("provider getter should be caught");
          },
        },
        api: {
          get() {
            throw new Error("api getter should be caught");
          },
        },
        input: {
          get() {
            throw new Error("input getter should be caught");
          },
        },
        reasoning: {
          get() {
            throw new Error("reasoning getter should be caught");
          },
        },
      },
    ) as Model<"openai-responses">;

    const input = convertResponsesMessages(
      model,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.5",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              { type: "thinking", thinking: "private thought", thinkingSignature: "opaque" },
              { type: "toolCall", id: "call:1|fc:item", name: "lookup", arguments: {} },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call:1|fc:item",
            toolName: "lookup",
            content: [
              { type: "text", text: "ok" },
              { type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
            ],
            isError: false,
            timestamp: 2,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
    ) as unknown as Array<Record<string, unknown>>;

    expect(input[0]).toEqual({ role: "system", content: "system" });
    expect(JSON.stringify(input)).not.toContain("private thought");
    expect(input.find((item) => item.type === "message")).toBeUndefined();
    expect(input.find((item) => item.type === "function_call")).toMatchObject({
      type: "function_call",
      call_id: "call_1_fc_item",
      name: "lookup",
      arguments: "{}",
    });
    expect(input.find((item) => item.type === "function_call_output")).toEqual({
      type: "function_call_output",
      call_id: "call_1_fc_item",
      output: "ok\n(tool image omitted: model does not support images)",
    });
  });
});

describe("createResponsesAssistantOutput", () => {
  it("uses explicit api and ignores unreadable optional model metadata", () => {
    const model = Object.defineProperties(
      { ...nativeOpenAIModel },
      {
        api: {
          get() {
            throw new Error("api getter should be caught");
          },
        },
        provider: {
          get() {
            throw new Error("provider getter should be caught");
          },
        },
        id: {
          get() {
            throw new Error("id getter should be caught");
          },
        },
      },
    ) as Model<"openai-responses">;

    expect(createResponsesAssistantOutput(model, "openai-responses")).toMatchObject({
      api: "openai-responses",
      provider: "",
      model: "",
    });
  });

  it("preserves readable accessor-backed model metadata", () => {
    const model = Object.defineProperties(
      { ...nativeOpenAIModel },
      {
        api: {
          get() {
            return "openai-responses";
          },
        },
        provider: {
          get() {
            return "openai";
          },
        },
        id: {
          get() {
            return "gpt-5.5";
          },
        },
      },
    ) as Model<"openai-responses">;

    expect(createResponsesAssistantOutput(model)).toMatchObject({
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
    });
  });
});

describe("Responses reasoning params", () => {
  it("ignores unreadable thinking metadata when applying common params", () => {
    const model = Object.defineProperties(
      { ...nativeOpenAIModel },
      {
        reasoning: {
          get() {
            throw new Error("reasoning getter should be caught");
          },
        },
        thinkingLevelMap: {
          get() {
            throw new Error("thinkingLevelMap getter should be caught");
          },
        },
      },
    ) as Model<"openai-responses">;
    const params = {} as Parameters<typeof applyCommonResponsesParams>[0];

    applyCommonResponsesParams(
      params,
      model,
      { messages: [], tools: [{ name: "lookup", description: "Lookup", parameters: {} }] },
      { reasoningEffort: "high", reasoningSummary: "auto" },
    );

    expect(params.reasoning).toBeUndefined();
    expect(params.tools).toHaveLength(1);
    expect(resolveResponsesReasoningEffort(model, "high")).toBeUndefined();
  });

  it("preserves readable accessor-backed thinking maps when applying common params", () => {
    const model = Object.defineProperties(
      { ...nativeOpenAIModel },
      {
        reasoning: {
          get() {
            return true;
          },
        },
        thinkingLevelMap: {
          get() {
            return { high: "medium", off: "low", xhigh: "xhigh" };
          },
        },
      },
    ) as Model<"openai-responses">;
    const params = {} as Parameters<typeof applyCommonResponsesParams>[0];

    applyCommonResponsesParams(params, model, { messages: [] }, { reasoningEffort: "high" });

    expect(params.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
    expect(resolveResponsesReasoningEffort(model, "max")).toBe("xhigh");
  });

  it("uses default reasoning-off params when the off mapping is unreadable", () => {
    const thinkingLevelMap = Object.defineProperties(
      {},
      {
        off: {
          get() {
            throw new Error("off getter should be caught");
          },
        },
      },
    );
    const model = Object.assign({}, nativeOpenAIModel, {
      thinkingLevelMap,
    }) as Model<"openai-responses">;
    const params = {} as Parameters<typeof applyCommonResponsesParams>[0];

    applyCommonResponsesParams(params, model, { messages: [] });

    expect(params.reasoning).toEqual({ effort: "none" });
  });
});
