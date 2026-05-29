import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import {
  createAssistantStreamAccumulator,
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createAnthropicThinkingPrefillPayloadWrapper,
  createPayloadPatchStreamWrapper,
  createPlainTextToolCallCompatWrapper,
  defaultToolStreamExtraParams,
  isOpenAICompatibleThinkingEnabled,
  stripTrailingAnthropicAssistantPrefillWhenThinking,
} from "./provider-stream-shared.js";

describe("defaultToolStreamExtraParams", () => {
  it("defaults tool_stream on when absent", () => {
    expect(defaultToolStreamExtraParams()).toEqual({ tool_stream: true });
    expect(defaultToolStreamExtraParams({ fastMode: true })).toEqual({
      fastMode: true,
      tool_stream: true,
    });
  });

  it("preserves explicit tool_stream values", () => {
    const enabled = { tool_stream: true, fastMode: true };
    const disabled = { tool_stream: false, fastMode: true };

    expect(defaultToolStreamExtraParams(enabled)).toBe(enabled);
    expect(defaultToolStreamExtraParams(disabled)).toBe(disabled);
  });
});

describe("isOpenAICompatibleThinkingEnabled", () => {
  it("uses explicit request reasoning before session thinking level", () => {
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "high",
        options: { reasoning: "none" } as never,
      }),
    ).toBe(false);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "off",
        options: { reasoningEffort: "medium" } as never,
      }),
    ).toBe(true);
  });

  it("treats off and none as disabled", () => {
    expect(isOpenAICompatibleThinkingEnabled({ thinkingLevel: "off", options: {} })).toBe(false);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "high",
        options: { reasoning: "none" } as never,
      }),
    ).toBe(false);
  });

  it("defaults to enabled for missing or non-string values", () => {
    expect(isOpenAICompatibleThinkingEnabled({ thinkingLevel: undefined, options: {} })).toBe(true);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "off",
        options: { reasoning: { effort: "off" } } as never,
      }),
    ).toBe(true);
  });
});

describe("createAssistantStreamAccumulator", () => {
  it("is available from the provider stream shared SDK subpath", () => {
    const accumulator = createAssistantStreamAccumulator({
      model: {
        api: "openai-compatible",
        provider: "example-provider",
        model: "example-model",
      },
      timestamp: 123,
    });

    accumulator.start();
    accumulator.startText(0);
    const delta = accumulator.appendTextDelta(0, "hi");
    const end = accumulator.endText(0);

    expect(delta.partial.content).toEqual([]);
    expect(end.partial.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("createPlainTextToolCallCompatWrapper", () => {
  it("lets replacement deltas supersede buffered plain-text tool-call candidates", async () => {
    const toolCallText = '[tool:read] {"path":"README.md"}';
    const finalMessage: AssistantMessage = {
      role: "assistant",
      api: "openai-compatible",
      provider: "test-provider",
      model: "test-model",
      content: [{ type: "text", text: toolCallText }],
      stopReason: "stop",
      timestamp: 123,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    };
    const emptyPartial: AssistantMessage = { ...finalMessage, content: [] };
    const baseStreamFn: StreamFn = () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "draft ",
            partial: emptyPartial,
          };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: toolCallText,
            replace: true,
            partial: emptyPartial,
          };
          yield { type: "done", reason: "stop", message: finalMessage };
        },
        result: async () => finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const stream = await Promise.resolve(
      wrapped({} as never, { tools: [{ name: "read" }] } as never, {}),
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(events.filter((event) => event.type === "text_delta")).toMatchObject([
      { delta: "draft " },
      { delta: "", replace: true },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
  });

  it("does not clear flushed text from a different content index", async () => {
    const toolCallText = '[tool:read] {"path":"README.md"}';
    const finalMessage: AssistantMessage = {
      role: "assistant",
      api: "openai-compatible",
      provider: "test-provider",
      model: "test-model",
      content: [{ type: "text", text: toolCallText }],
      stopReason: "stop",
      timestamp: 123,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    };
    const emptyPartial: AssistantMessage = { ...finalMessage, content: [] };
    const baseStreamFn: StreamFn = () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "I will check.",
            partial: emptyPartial,
          };
          yield {
            type: "text_delta",
            contentIndex: 1,
            delta: toolCallText,
            replace: true,
            partial: emptyPartial,
          };
          yield { type: "done", reason: "stop", message: finalMessage };
        },
        result: async () => finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const stream = await Promise.resolve(
      wrapped({} as never, { tools: [{ name: "read" }] } as never, {}),
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "text_delta")).toMatchObject([
      { contentIndex: 0, delta: "I will check." },
    ]);
    expect(events.some((event) => event.type === "text_delta" && event.replace === true)).toBe(
      false,
    );
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
  });
});

describe("createDeepSeekV4OpenAICompatibleThinkingWrapper", () => {
  it("backfills reasoning_content on every replayed assistant message when thinking is enabled", () => {
    const payload = {
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", tool_calls: [{ id: "call_1", name: "read" }] },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "done" },
        { role: "assistant", content: "kept", reasoning_content: "native reasoning" },
      ],
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload as never, _model as never);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn,
      thinkingLevel: "high",
      shouldPatchModel: () => true,
    });
    void wrapped?.({} as never, {} as never, {});

    expect(payload.messages[0]).not.toHaveProperty("reasoning_content");
    expect(payload.messages[1]).toHaveProperty("reasoning_content", "");
    expect(payload.messages[2]).not.toHaveProperty("reasoning_content");
    expect(payload.messages[3]).toHaveProperty("reasoning_content", "");
    expect(payload.messages[4]).toHaveProperty("reasoning_content", "native reasoning");
  });
});

describe("createPayloadPatchStreamWrapper", () => {
  it("passes stream call options to payload patches", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, options }) => {
      payload.reasoning = (options as { reasoning?: unknown } | undefined)?.reasoning;
    });
    void wrapped(
      { id: "model" } as never,
      { messages: [] } as never,
      {
        reasoning: "medium",
      } as never,
    );

    expect(captured).toEqual({ reasoning: "medium" });
  });

  it("calls the underlying stream directly when shouldPatch rejects the model", () => {
    let onPayloadWasInstalled = false;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      onPayloadWasInstalled = typeof options?.onPayload === "function";
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createPayloadPatchStreamWrapper(
      baseStreamFn,
      ({ payload }) => {
        payload.unexpected = true;
      },
      { shouldPatch: () => false },
    );
    void wrapped({ id: "model" } as never, { messages: [] } as never, {});

    expect(onPayloadWasInstalled).toBe(false);
  });
});

describe("stripTrailingAnthropicAssistantPrefillWhenThinking", () => {
  it("removes trailing assistant text turns when Anthropic thinking is enabled", () => {
    const payload = {
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
        { role: "assistant", content: '"status"' },
      ],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(2);
    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });

  it("preserves assistant tool-use turns across Anthropic and OpenAI-shaped payloads", () => {
    const anthropicPayload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read" }] },
      ],
    };
    const openAiPayload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "Read" }] },
      ],
    };
    const toolCallsPayload = {
      thinking: { type: "adaptive" },
      messages: [{ role: "assistant", tool_calls: [{ id: "call_1", name: "Read" }] }],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(anthropicPayload)).toBe(0);
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(openAiPayload)).toBe(0);
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(toolCallsPayload)).toBe(0);
  });

  it("keeps assistant prefill when Anthropic thinking is disabled", () => {
    const payload = {
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(0);
    expect(payload.messages).toHaveLength(2);
  });
});

describe("createAnthropicThinkingPrefillPayloadWrapper", () => {
  it("reports stripped assistant prefill count", () => {
    const payload = {
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };
    let strippedCount = 0;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload as never, _model as never);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createAnthropicThinkingPrefillPayloadWrapper(
      baseStreamFn,
      (stripped) => {
        strippedCount = stripped;
      },
      { shouldPatch: ({ model }) => model.api === "anthropic-messages" },
    );
    void wrapped({ api: "anthropic-messages" } as never, {} as never, {});

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(strippedCount).toBe(1);
  });
});
