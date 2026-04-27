import { describe, it, expect } from "vitest";
import { getContextWindow, getModelContextWindow } from "@/lib/model-registry";

describe("getContextWindow (legacy: model's default 200k window)", () => {
  // The single-arg helper returns the model's *default* window. The 1M tier is
  // an explicit opt-in via the mode parameter on `getModelContextWindow`.
  it("returns 200_000 for Opus 4.7", () => {
    expect(getContextWindow("claude-opus-4-7")).toBe(200_000);
  });
  it("returns 200_000 for Opus 4.6", () => {
    expect(getContextWindow("claude-opus-4-6")).toBe(200_000);
  });
  it("returns 200_000 for Sonnet 4.6", () => {
    expect(getContextWindow("claude-sonnet-4-6")).toBe(200_000);
  });
  it("returns 200_000 for Haiku 4.5", () => {
    expect(getContextWindow("claude-haiku-4-5")).toBe(200_000);
  });
  it("returns undefined for Codex models (not populated statically)", () => {
    expect(getContextWindow("gpt-5.4")).toBeUndefined();
  });
});

describe("getModelContextWindow (mode-aware)", () => {
  it("returns 1_000_000 for Opus 4.7 in 1m mode", () => {
    expect(getModelContextWindow("claude-opus-4-7", "1m")).toBe(1_000_000);
  });
  it("returns 1_000_000 for Opus 4.6 in 1m mode", () => {
    expect(getModelContextWindow("claude-opus-4-6", "1m")).toBe(1_000_000);
  });
  it("returns 1_000_000 for Sonnet 4.6 in 1m mode", () => {
    expect(getModelContextWindow("claude-sonnet-4-6", "1m")).toBe(1_000_000);
  });
  it("falls back to 200_000 for Haiku 4.5 even in 1m mode (not supported)", () => {
    expect(getModelContextWindow("claude-haiku-4-5", "1m")).toBe(200_000);
  });
  it("returns 200_000 for any supported model in 200k mode", () => {
    expect(getModelContextWindow("claude-opus-4-7", "200k")).toBe(200_000);
    expect(getModelContextWindow("claude-sonnet-4-6", "200k")).toBe(200_000);
  });
  it("resolves dated SDK variants via prefix match", () => {
    expect(getModelContextWindow("claude-haiku-4-5-20251001", "200k")).toBe(200_000);
    expect(getModelContextWindow("claude-sonnet-4-6-20260101", "1m")).toBe(1_000_000);
  });
});
