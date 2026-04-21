import { describe, it, expect } from "vitest";
import { MODEL_CONTEXT_WINDOWS, getModelContextWindow } from "../index.js";

describe("MODEL_CONTEXT_WINDOWS", () => {
  it("exposes 1M for Claude Opus 4.7", () => {
    expect(MODEL_CONTEXT_WINDOWS["claude-opus-4-7"]).toBe(1_000_000);
  });
  it("exposes 1M for Claude Opus 4.6", () => {
    expect(MODEL_CONTEXT_WINDOWS["claude-opus-4-6"]).toBe(1_000_000);
  });
  it("exposes 1M for Claude Sonnet 4.6", () => {
    expect(MODEL_CONTEXT_WINDOWS["claude-sonnet-4-6"]).toBe(1_000_000);
  });
  it("exposes 200K for Claude Haiku 4.5", () => {
    expect(MODEL_CONTEXT_WINDOWS["claude-haiku-4-5"]).toBe(200_000);
  });
});

describe("getModelContextWindow", () => {
  it("returns the value for exact base IDs", () => {
    expect(getModelContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
    expect(getModelContextWindow("claude-haiku-4-5")).toBe(200_000);
  });

  it("matches dated SDK variants by longest-prefix", () => {
    // Anthropic SDK can return dated variants like claude-haiku-4-5-20251001.
    expect(getModelContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(getModelContextWindow("claude-sonnet-4-6-20260101")).toBe(1_000_000);
  });

  it("returns undefined for unknown models", () => {
    expect(getModelContextWindow("gpt-5.4")).toBeUndefined();
    expect(getModelContextWindow("")).toBeUndefined();
    expect(getModelContextWindow("not-a-real-model")).toBeUndefined();
    expect(getModelContextWindow("claude-haiku-4-5abc")).toBeUndefined();
  });
});
