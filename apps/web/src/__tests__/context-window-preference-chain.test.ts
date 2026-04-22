import { describe, it, expect } from "vitest";
import { resolveContextWindow } from "@/lib/resolve-context-window";

describe("resolveContextWindow preference chain", () => {
  it("prefers user settings override when model matches default", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: 200_000,
        modelId: "claude-sonnet-4-6",
        defaultModelId: "claude-sonnet-4-6",
        settingsContextWindow: 500_000,   // user's override
        registryContextWindow: 1_000_000, // registry would give this
        previousContextWindow: undefined,
      }),
    ).toBe(500_000); // user's override wins
  });

  it("ignores user settings override when model differs from default", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: 200_000,
        modelId: "claude-haiku-4-5",
        defaultModelId: "claude-sonnet-4-6",
        settingsContextWindow: 1_000_000,
        registryContextWindow: 200_000,
        previousContextWindow: undefined,
      }),
    ).toBe(200_000);
  });

  it("falls back to registry when no user override", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: 200_000,
        modelId: "claude-sonnet-4-6",
        defaultModelId: "claude-sonnet-4-6",
        settingsContextWindow: undefined,
        registryContextWindow: 1_000_000,
        previousContextWindow: undefined,
      }),
    ).toBe(1_000_000);
  });

  it("falls back to SDK when registry has no value", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: 200_000,
        modelId: "unknown-model",
        defaultModelId: "claude-sonnet-4-6",
        settingsContextWindow: undefined,
        registryContextWindow: undefined,
        previousContextWindow: undefined,
      }),
    ).toBe(200_000);
  });

  it("falls back to previously stored value as last resort", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: undefined,
        modelId: "unknown-model",
        defaultModelId: "claude-sonnet-4-6",
        settingsContextWindow: undefined,
        registryContextWindow: undefined,
        previousContextWindow: 128_000,
      }),
    ).toBe(128_000);
  });

  it("returns undefined when no source has a value", () => {
    expect(
      resolveContextWindow({
        sdkContextWindow: undefined,
        modelId: "unknown-model",
        defaultModelId: "claude-sonnet-4-6",
        settingsContextWindow: undefined,
        registryContextWindow: undefined,
        previousContextWindow: undefined,
      }),
    ).toBeUndefined();
  });
});
