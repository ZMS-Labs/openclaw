// Shared model utility tests cover provider-agnostic thinking metadata handling.
import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "./model-utils.js";
import type { Model } from "./types.js";

const baseModel = {
  id: "reasoning-model",
  name: "Reasoning Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} satisfies Model<"openai-responses">;

describe("thinking level metadata", () => {
  it("treats unreadable model thinking metadata as non-reasoning", () => {
    const model = Object.defineProperties(
      { ...baseModel },
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

    expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
    expect(clampThinkingLevel(model, "high")).toBe("off");
  });

  it("preserves readable accessor-backed thinking metadata", () => {
    const model = Object.defineProperties(
      { ...baseModel },
      {
        reasoning: {
          get() {
            return true;
          },
        },
        thinkingLevelMap: {
          get() {
            return { off: null, low: null, xhigh: "high", max: null };
          },
        },
      },
    ) as Model<"openai-responses">;

    expect(getSupportedThinkingLevels(model)).toEqual(["minimal", "medium", "high", "xhigh"]);
    expect(clampThinkingLevel(model, "max")).toBe("xhigh");
  });

  it("skips unreadable thinking-level map entries", () => {
    const thinkingLevelMap = Object.defineProperties(
      {},
      {
        xhigh: {
          get() {
            throw new Error("xhigh getter should be caught");
          },
        },
        max: {
          value: "max",
        },
      },
    );
    const model = Object.assign({}, baseModel, { thinkingLevelMap }) as Model<"openai-responses">;

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
  });
});
