import { describe, it, expect } from "vitest";
import { getContextWindow } from "@/lib/model-registry";

describe("getContextWindow (Claude static values)", () => {
  it("returns 1_000_000 for Opus 4.7", () => {
    expect(getContextWindow("claude-opus-4-7")).toBe(1_000_000);
  });
  it("returns 1_000_000 for Opus 4.6", () => {
    expect(getContextWindow("claude-opus-4-6")).toBe(1_000_000);
  });
  it("returns 1_000_000 for Sonnet 4.6", () => {
    expect(getContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
  });
  it("returns 200_000 for Haiku 4.5", () => {
    expect(getContextWindow("claude-haiku-4-5")).toBe(200_000);
  });
  it("resolves dated SDK variants via prefix match", () => {
    expect(getContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
  });
  it("returns undefined for Codex models (not populated statically)", () => {
    expect(getContextWindow("gpt-5.4")).toBeUndefined();
  });
});
