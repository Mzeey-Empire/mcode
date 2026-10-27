import type { ProviderModelInfo } from "@mcode/contracts/providers/models";
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
      options: { thinking: true },
      toProvider: "claude",
      targetModel: null,
    });

    expect(result.options).toEqual({ thinking: true });
    expect(result.dropped).toEqual([]);
  });

  it("keeps Fast when the target model declares it, whichever provider owns the model", () => {
    const result = reconcileSwitchOptions({
      options: { fastMode: true },
      toProvider: "claude",
      targetModel: model({ id: "opus", supportsFastMode: true }),
    });

    expect(result.options).toEqual({ fastMode: true });
    expect(result.dropped).toEqual([]);
  });

  it.each([
    ["does not declare Fast", model({ id: "gpt-5.4-mini", supportsFastMode: false })],
    ["is missing from the catalog", null],
  ])("drops Fast when the target model %s", (_case, targetModel) => {
    const result = reconcileSwitchOptions({
      options: { fastMode: true },
      toProvider: "codex",
      targetModel,
    });

    expect(result.options).toEqual({});
    expect(result.dropped).toEqual([
      expect.objectContaining({ option: "fastMode", value: true }),
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
