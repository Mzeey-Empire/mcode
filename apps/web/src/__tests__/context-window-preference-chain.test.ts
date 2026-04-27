import { describe, it, expect } from "vitest";
import { resolveContextWindow } from "@/lib/resolve-context-window";

describe("resolveContextWindow preference chain", () => {
  it("prefers SDK runtime value when present (truthful, post-fallback)", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: 200_000,
        modelId: "claude-sonnet-4-6",
        contextWindowMode: "1m",
        previousContextWindow: undefined,
      }),
    ).toBe(200_000);
  });

  it("returns 1M when mode is '1m' and the model supports it", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: undefined,
        modelId: "claude-sonnet-4-6",
        contextWindowMode: "1m",
        previousContextWindow: undefined,
      }),
    ).toBe(1_000_000);
  });

  it("returns the standard window when mode is '200k'", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: undefined,
        modelId: "claude-sonnet-4-6",
        contextWindowMode: "200k",
        previousContextWindow: undefined,
      }),
    ).toBe(200_000);
  });

  it("falls back to default 200k for models that don't support 1M", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: undefined,
        modelId: "claude-haiku-4-5",
        contextWindowMode: "1m",
        previousContextWindow: undefined,
      }),
    ).toBe(200_000);
  });

  it("falls back to previously stored value when nothing else has a value", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: undefined,
        modelId: "unknown-model",
        contextWindowMode: "200k",
        previousContextWindow: 128_000,
      }),
    ).toBe(128_000);
  });

  it("returns undefined when no source has a value", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: undefined,
        modelId: "unknown-model",
        contextWindowMode: "200k",
        previousContextWindow: undefined,
      }),
    ).toBeUndefined();
  });
});
