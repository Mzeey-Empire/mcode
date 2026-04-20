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

describe("ProviderAvailabilityService.verifyCli", () => {
  it("reports 'found' when which resolves the binary", async () => {
    const svc = new ProviderAvailabilityService(
      stubSettings(),
      stubRegistry(["claude"]),
      {
        which: vi.fn(async () => "/usr/local/bin/claude"),
        statExecutable: vi.fn(async () => true),
      },
    );
    const result = await svc.verifyCli("claude");
    expect(result).toEqual({ status: "found", resolvedPath: "/usr/local/bin/claude" });
  });

  it("reports 'not_found' when which throws", async () => {
    const svc = new ProviderAvailabilityService(
      stubSettings(),
      stubRegistry(["claude"]),
      {
        which: vi.fn(async () => { throw new Error("not on PATH"); }),
        statExecutable: vi.fn(async () => false),
      },
    );
    const result = await svc.verifyCli("claude");
    expect(result.status).toBe("not_found");
    expect(result.resolvedPath).toBeNull();
  });

  it("prefers a configured path over PATH lookup and validates it with statExecutable", async () => {
    const s = getDefaultSettings();
    s.provider.cli.codex = "/custom/codex";
    const stat = vi.fn(async () => true);
    const which = vi.fn();
    const svc = new ProviderAvailabilityService(
      { get: () => s, on: () => {} } as unknown as SettingsService,
      stubRegistry(["codex"]),
      { which, statExecutable: stat },
    );
    const result = await svc.verifyCli("codex");
    expect(which).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledWith("/custom/codex");
    expect(result).toEqual({ status: "found", resolvedPath: "/custom/codex" });
  });

  it("caches result and reflects it in listAvailability", async () => {
    const svc = new ProviderAvailabilityService(
      stubSettings(),
      stubRegistry(["claude"]),
      { which: vi.fn(async () => "/usr/local/bin/claude"), statExecutable: vi.fn() },
    );
    await svc.verifyCli("claude");
    const row = svc.listAvailability().find((p) => p.id === "claude")!;
    expect(row.cli.status).toBe("found");
    expect(row.cli.resolvedPath).toBe("/usr/local/bin/claude");
  });
});
