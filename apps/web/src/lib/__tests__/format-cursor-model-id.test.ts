import { describe, it, expect } from "vitest";
import { formatCursorCliModelId, isCursorCliModelId } from "../format-cursor-model-id";

describe("isCursorCliModelId", () => {
  it("detects Cursor CLI id shapes", () => {
    expect(isCursorCliModelId("composer-2.5-fast")).toBe(true);
    expect(isCursorCliModelId("claude-opus-4-7-thinking-high")).toBe(true);
    expect(isCursorCliModelId("gpt-5.4-high-fast")).toBe(true);
    expect(isCursorCliModelId("claude-opus-4-7")).toBe(true);
    expect(isCursorCliModelId("claude-haiku-4-5-20251001")).toBe(false);
    expect(isCursorCliModelId("claude-4.6-opus-high")).toBe(true);
  });
});

describe("formatCursorCliModelId", () => {
  it("formats Composer modules", () => {
    expect(formatCursorCliModelId("composer-2.5-fast")).toBe("Composer 2.5 Fast");
    expect(formatCursorCliModelId("composer-2")).toBe("Composer 2");
  });

  it("formats Claude 4.7-style Opus ids", () => {
    expect(formatCursorCliModelId("claude-opus-4-7-thinking-high")).toBe(
      "Opus 4.7 1M High Thinking",
    );
    expect(formatCursorCliModelId("claude-opus-4-7-high-fast")).toBe("Opus 4.7 1M High Fast");
  });

  it("formats Claude 4.6-style ids", () => {
    expect(formatCursorCliModelId("claude-4.6-opus-high-thinking-fast")).toBe(
      "Opus 4.6 High Thinking Fast",
    );
    expect(formatCursorCliModelId("claude-4.6-sonnet-medium")).toBe("Sonnet 4.6 1M");
  });

  it("formats GPT and Codex ids", () => {
    expect(formatCursorCliModelId("gpt-5.4-high-fast")).toBe("GPT-5.4 High Fast");
    expect(formatCursorCliModelId("gpt-5.3-codex-xhigh-fast")).toBe("Codex 5.3 Extra High Fast");
    expect(formatCursorCliModelId("gpt-5.4-medium")).toBe("GPT-5.4 1M");
  });

  it("formats other vendor prefixes", () => {
    expect(formatCursorCliModelId("grok-build-0.1")).toBe("Grok Build 0.1");
    expect(formatCursorCliModelId("gemini-3.1-pro")).toBe("Gemini 3.1 Pro");
    expect(formatCursorCliModelId("kimi-k2.5")).toBe("Kimi K2.5");
  });
});
