import { describe, expect, it } from "vitest";
import { parseClaudeContextUsage } from "../context-usage.js";

describe("Claude context usage boundary", () => {
  it.each([0, NaN, undefined])("rejects an invalid raw window: %s", rawMaxTokens => {
    expect(parseClaudeContextUsage({ rawMaxTokens, totalTokens: 18000 })).toBeUndefined();
  });

  it("reads the resolved window rather than the model maximum", () => {
    expect(parseClaudeContextUsage({ rawMaxTokens: 300000, maxTokens: 1000000, totalTokens: 18000 }))
      .toEqual({ windowTokens: 300000, usedTokens: 18000 });
  });
});
