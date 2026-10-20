import type { ProviderModelInfo } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { reconcileSwitchOptions } from "../provider-switch-options.js";

function model(overrides: Partial<ProviderModelInfo>): ProviderModelInfo {
  return { id: "gpt-5", name: "GPT-5", ...overrides } as ProviderModelInfo;
}

describe("reconcileSwitchOptions", () => {
  it("drops options owned by the provider being left and reports each", () => {
    const result = reconcileSwitchOptions({
      options: { contextWindow: "1m", thinking: true, reasoningLevel: "high" },
      toProvider: "codex",
      targetModel: model({ supportedReasoningEfforts: ["low", "medium", "high"] }),
    });

    expect(result.options).toEqual({ reasoningLevel: "high" });
    expect(result.dropped.map((d) => d.option).sort()).toEqual(["contextWindow", "thinking"]);
  });

  it("keeps the target provider's own toggles", () => {
    const result = reconcileSwitchOptions({
      options: { codexFastMode: true },
      toProvider: "codex",
      targetModel: null,
    });

    expect(result.options).toEqual({ codexFastMode: true });
    expect(result.dropped).toEqual([]);
  });

  it("drops Fast when switching away from Codex", () => {
    const result = reconcileSwitchOptions({
      options: { codexFastMode: true },
      toProvider: "claude",
      targetModel: null,
    });

    expect(result.options).toEqual({});
    expect(result.dropped).toEqual([
      expect.objectContaining({ option: "codexFastMode", value: true }),
    ]);
  });

  it("drops a reasoning level the target model's catalog entry omits", () => {
    const result = reconcileSwitchOptions({
      options: { reasoningLevel: "max" },
      toProvider: "claude",
      targetModel: model({ id: "haiku", supportedReasoningEfforts: ["low", "medium", "high"] }),
    });

    expect(result.options.reasoningLevel).toBeUndefined();
    expect(result.dropped).toEqual([
      expect.objectContaining({ option: "reasoningLevel", value: "max" }),
    ]);
  });

  it("keeps the reasoning level when the target model is not in the catalog", () => {
    const result = reconcileSwitchOptions({
      options: { reasoningLevel: "max" },
      toProvider: "claude",
      targetModel: null,
    });

    expect(result.options.reasoningLevel).toBe("max");
    expect(result.dropped).toEqual([]);
  });
});
