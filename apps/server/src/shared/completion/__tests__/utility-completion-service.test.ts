import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UtilityCompletionService } from "../utility-completion-service.js";
import type { IProviderRegistry, IAgentProvider } from "@mcode/contracts/providers/interfaces";
import type { SettingsService } from "../../../features/settings/settings-service.js";
import type { ProviderAvailabilityService } from "../../../features/providers/availability/provider-availability-service.js";

function mockProvider(supportsCompletion: boolean) {
  return {
    id: "claude",
    supportsCompletion,

    maxInputCharactersPerTurn: 16_000,
    complete: vi.fn().mockResolvedValue("summary result"),
  } as unknown as IAgentProvider & { complete: ReturnType<typeof vi.fn> };
}

function mockSettingsService(overrides: {
  utilityProvider?: string;
  utilityId?: string;
  defaultsProvider?: string;
}) {
  return {
    get: vi.fn().mockReturnValue({
      model: {
        defaults: { provider: overrides.defaultsProvider ?? "claude" },
        utility: {
          provider: overrides.utilityProvider ?? "",
          id: overrides.utilityId ?? "",
        },
      },
    }),
  } as unknown as SettingsService;
}

describe("UtilityCompletionService", () => {
  let registry: IProviderRegistry;
  let availability: ProviderAvailabilityService;

  beforeEach(() => {
    availability = {
      assertUsable: vi.fn(),
    } as unknown as ProviderAvailabilityService;
  });

  it("uses model.utility.provider when set", async () => {
    const provider = mockProvider(true);
    registry = {
      resolve: vi.fn().mockReturnValue(provider),
    } as unknown as IProviderRegistry;

    const settings = mockSettingsService({
      utilityProvider: "copilot",
      utilityId: "gpt-4.1-mini",
    });

    const svc = new UtilityCompletionService(settings, registry, availability);
    const result = await svc.complete("test prompt", "/tmp");

    expect(registry.resolve).toHaveBeenCalledWith("copilot");
    expect(provider.complete).toHaveBeenCalledWith(
      "test prompt",
      "gpt-4.1-mini",
      "/tmp",
      {},
    );
    expect(result).toEqual({ text: "summary result", provider: "copilot", model: "gpt-4.1-mini" });
  });

  it("falls back to model.defaults.provider when utility.provider is empty", async () => {
    const provider = mockProvider(true);
    registry = {
      resolve: vi.fn().mockReturnValue(provider),
    } as unknown as IProviderRegistry;

    const settings = mockSettingsService({ defaultsProvider: "claude" });
    const svc = new UtilityCompletionService(settings, registry, availability);
    await svc.complete("prompt", "/tmp");

    expect(registry.resolve).toHaveBeenCalledWith("claude");
  });

  it("falls back to claude when resolved provider lacks completion", async () => {
    const noCompletion = mockProvider(false);
    const claudeProvider = mockProvider(true);
    registry = {
      resolve: vi.fn().mockImplementation((id: string) =>
        id === "claude" ? claudeProvider : noCompletion,
      ),
    } as unknown as IProviderRegistry;

    const settings = mockSettingsService({ defaultsProvider: "gemini" });
    const svc = new UtilityCompletionService(settings, registry, availability);
    const result = await svc.complete("prompt", "/tmp");

    expect(registry.resolve).toHaveBeenCalledWith("gemini");
    expect(registry.resolve).toHaveBeenCalledWith("claude");
    expect(claudeProvider.complete).toHaveBeenCalled();
    expect(result.provider).toBe("claude");
  });

  it("runs the default Claude model, Haiku 5.5, at low effort when utility.id is empty", async () => {
    const provider = mockProvider(true);
    registry = {
      resolve: vi.fn().mockReturnValue(provider),
    } as unknown as IProviderRegistry;

    const settings = mockSettingsService({
      utilityProvider: "claude",
      utilityId: "",
    });
    const svc = new UtilityCompletionService(settings, registry, availability);
    const result = await svc.complete("prompt", "/tmp");

    expect(provider.complete).toHaveBeenCalledWith(
      "prompt",
      "claude-haiku-5-5",
      "/tmp",
      { reasoningLevel: "low" },
    );
    expect(result.model).toBe("claude-haiku-5-5");
  });

  it("keeps the caller's reasoning level over the default model's", async () => {
    const provider = mockProvider(true);
    registry = {
      resolve: vi.fn().mockReturnValue(provider),
    } as unknown as IProviderRegistry;

    const settings = mockSettingsService({ utilityProvider: "claude" });
    const svc = new UtilityCompletionService(settings, registry, availability);
    await svc.complete("prompt", "/tmp", { reasoningLevel: "high" });

    expect(provider.complete).toHaveBeenCalledWith(
      "prompt",
      "claude-haiku-5-5",
      "/tmp",
      { reasoningLevel: "high" },
    );
  });
});
