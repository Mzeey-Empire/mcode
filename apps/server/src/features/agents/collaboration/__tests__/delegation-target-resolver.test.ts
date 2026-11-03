import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { type IAgentProvider, type IProviderRegistry } from "@mcode/contracts/providers/interfaces";
import { DelegationTargetResolver } from "../delegation-target-resolver.js";

function provider(id: "claude" | "codex"): IAgentProvider {
  return { id, listModels: vi.fn(), supportsCompletion: false } as unknown as IAgentProvider;
}

describe("DelegationTargetResolver", () => {
  it("lists only enabled providers with usable models and valid defaults", async () => {
    const settings = getDefaultSettings();
    settings.provider.enabled.codex = true;
    settings.provider.enabled.claude = false;
    settings.model.defaults.provider = "codex";
    settings.model.defaults.id = "gpt-5.6-sol";
    const codex = provider("codex");
    const registry: IProviderRegistry = {
      resolve: vi.fn((id) => id === "codex" ? codex : (() => { throw new Error("missing"); })()),
      resolveAll: () => [codex, provider("claude")],
      shutdown: vi.fn(),
    };
    const models = { listModels: vi.fn().mockResolvedValue([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "blocked", name: "Blocked", policy: { state: "disabled" } },
    ]) };
    const resolver = new DelegationTargetResolver(registry, models as never, { get: () => settings } as never);
    await expect(resolver.listTargets()).resolves.toEqual({ providers: [{
      providerId: "codex", name: "Codex", models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }], defaultModelId: "gpt-5.6-sol",
    }] });
  });

  it("requires a model for cross-provider creation and validates explicit pairs", async () => {
    const settings = getDefaultSettings();
    const codex = provider("codex");
    settings.model.defaults.provider = "claude";
    settings.model.defaults.id = "claude-model";
    const registry: IProviderRegistry = { resolve: () => codex, resolveAll: () => [codex], shutdown: vi.fn() };
    const models = { listModels: vi.fn().mockResolvedValue([{ id: "gpt", name: "GPT" }]) };
    const resolver = new DelegationTargetResolver(registry, models as never, { get: () => settings } as never);
    await expect(resolver.resolve({ providerId: "codex" })).resolves.toEqual({ status: "model_required" });
    await expect(resolver.resolve({ providerId: "codex", modelId: "missing" })).resolves.toEqual({ status: "invalid_model" });
    await expect(resolver.resolve({ providerId: "codex", modelId: "gpt" })).resolves.toEqual({ status: "resolved", providerId: "codex", modelId: "gpt" });
  });

  it("inherits the global pair only when the explicit provider matches", async () => {
    const settings = getDefaultSettings();
    settings.model.defaults.provider = "codex";
    settings.model.defaults.id = " gpt ";
    const codex = provider("codex");
    const registry: IProviderRegistry = { resolve: () => codex, resolveAll: () => [codex], shutdown: vi.fn() };
    const models = { listModels: vi.fn().mockResolvedValue([{ id: "gpt", name: "GPT" }]) };
    const resolver = new DelegationTargetResolver(registry, models as never, { get: () => settings } as never);
    await expect(resolver.listTargets()).resolves.toEqual({
      providers: [{ providerId: "codex", name: "Codex", models: [{ id: "gpt", name: "GPT" }], defaultModelId: "gpt" }],
    });
    await expect(resolver.resolve({})).resolves.toEqual({ status: "resolved", providerId: "codex", modelId: "gpt" });
    await expect(resolver.resolve({ providerId: "codex" })).resolves.toEqual({ status: "resolved", providerId: "codex", modelId: "gpt" });
  });

  describe("reasoning effort option", () => {
    const catalog = [
      { id: "tiered", name: "Tiered", supportedReasoningEfforts: ["high", "low", "medium"], defaultReasoningEffort: "medium" },
      { id: "high-only", name: "High only", supportedReasoningEfforts: ["xhigh", "max"], defaultReasoningEffort: "xhigh" },
      { id: "plain", name: "Plain", supportsReasoning: true },
    ];

    function setup() {
      const settings = getDefaultSettings();
      settings.provider.enabled.codex = true;
      settings.model.defaults.provider = "codex";
      settings.model.defaults.id = "tiered";
      const codex = provider("codex");
      const registry: IProviderRegistry = { resolve: () => codex, resolveAll: () => [codex], shutdown: vi.fn() };
      const models = { listModels: vi.fn().mockResolvedValue(catalog) };
      const resolver = new DelegationTargetResolver(registry, models as never, { get: () => settings } as never);
      return { resolver, settings };
    }

    it("carries the model's levels lowest first with the user's default snapped onto them", async () => {
      const { resolver } = setup();
      await expect(resolver.resolve({ providerId: "codex", modelId: "tiered" })).resolves.toStrictEqual({
        status: "resolved", providerId: "codex", modelId: "tiered",
        reasoningEffortOption: { id: "reasoningEffort", values: ["low", "medium", "high"], default: "high" },
      });
    });

    it("resolves a model without levels with no option", async () => {
      const { resolver } = setup();
      await expect(resolver.resolve({ providerId: "codex", modelId: "plain" })).resolves.toStrictEqual({
        status: "resolved", providerId: "codex", modelId: "plain",
      });
    });

    it("moves the resolved default with the user default, matching the listed default", async () => {
      const { resolver, settings } = setup();
      for (const [userDefault, tiered, highOnly] of [["low", "low", "xhigh"], ["max", "high", "max"], ["xhigh", "high", "xhigh"]] as const) {
        settings.model.defaults.reasoning = userDefault;
        const { providers } = await resolver.listTargets();
        const listed = providers[0]?.models.map((model) => model.options?.[0]?.default);
        expect(listed).toEqual([tiered, highOnly, undefined]);
        await expect(resolver.resolve({ providerId: "codex", modelId: "tiered" }))
          .resolves.toMatchObject({ reasoningEffortOption: { default: tiered } });
        await expect(resolver.resolve({ providerId: "codex", modelId: "high-only" }))
          .resolves.toMatchObject({ reasoningEffortOption: { default: highOnly } });
      }
    });
  });
});
