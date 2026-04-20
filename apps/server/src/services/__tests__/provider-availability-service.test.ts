import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderAvailabilityService } from "../provider-availability-service.js";
import type { SettingsService } from "../settings-service.js";
import type { IProviderRegistry, IAgentProvider } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";

function stubSettings(overrides: Partial<ReturnType<typeof getDefaultSettings>> = {}): SettingsService {
  const settings = { ...getDefaultSettings(), ...overrides };
  return {
    get: vi.fn(() => settings),
    on: vi.fn(),
  } as unknown as SettingsService;
}

function stubRegistry(ids: string[]): IProviderRegistry {
  const providers = ids.map((id) => ({ id } as IAgentProvider));
  return {
    resolve: vi.fn((id) => providers.find((p) => p.id === id)!),
    resolveAll: vi.fn(() => providers),
    shutdown: vi.fn(),
  };
}

describe("ProviderAvailabilityService.listAvailability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reflects settings.provider.enabled flags in output", () => {
    const s = getDefaultSettings();
    s.provider.enabled.codex = false;
    const svc = new ProviderAvailabilityService(
      { get: () => s, on: () => {} } as unknown as SettingsService,
      stubRegistry(["claude", "codex", "copilot"]),
    );
    const list = svc.listAvailability();
    expect(list.find((p) => p.id === "codex")?.enabled).toBe(false);
    expect(list.find((p) => p.id === "claude")?.enabled).toBe(true);
  });

  it("marks hasAdapter=false for providers missing from the registry", () => {
    const svc = new ProviderAvailabilityService(
      stubSettings(),
      stubRegistry(["claude"]),
    );
    const list = svc.listAvailability();
    expect(list.find((p) => p.id === "claude")?.hasAdapter).toBe(true);
    expect(list.find((p) => p.id === "gemini")?.hasAdapter).toBe(false);
  });

  it("returns catalog order: claude, codex, copilot, gemini, cursor, opencode", () => {
    const svc = new ProviderAvailabilityService(stubSettings(), stubRegistry([]));
    expect(svc.listAvailability().map((p) => p.id)).toEqual([
      "claude", "codex", "copilot", "gemini", "cursor", "opencode",
    ]);
  });

  it("initial cli.status for every entry is 'unchecked'", () => {
    const svc = new ProviderAvailabilityService(stubSettings(), stubRegistry(["claude"]));
    for (const row of svc.listAvailability()) {
      expect(row.cli.status).toBe("unchecked");
    }
  });
});
