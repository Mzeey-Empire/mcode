import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderAvailabilityService } from "../provider-availability-service.js";
import type { SettingsService } from "../settings-service.js";
import type { IProviderRegistry, IAgentProvider, ProviderAvailability } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { ProviderDisabledError, ProviderCliMissingError } from "../provider-availability-errors.js";

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

describe("ProviderAvailabilityService.assertUsable", () => {
  it("throws ProviderDisabledError when the toggle is off", async () => {
    const s = getDefaultSettings();
    s.provider.enabled.codex = false;
    const svc = new ProviderAvailabilityService(
      { get: () => s, on: () => {} } as unknown as SettingsService,
      stubRegistry(["claude", "codex"]),
    );
    expect(() => svc.assertUsable("codex")).toThrow(ProviderDisabledError);
  });

  it("throws ProviderDisabledError for coming-soon providers regardless of settings", () => {
    const s = getDefaultSettings();
    s.provider.enabled.gemini = true;
    const svc = new ProviderAvailabilityService(
      { get: () => s, on: () => {} } as unknown as SettingsService,
      stubRegistry([]),
    );
    expect(() => svc.assertUsable("gemini")).toThrow(ProviderDisabledError);
  });

  it("throws ProviderCliMissingError when enabled but CLI not_found", async () => {
    const svc = new ProviderAvailabilityService(
      stubSettings(),
      stubRegistry(["claude"]),
      { which: vi.fn(async () => { throw new Error("nope"); }), statExecutable: vi.fn() },
    );
    await svc.verifyCli("claude");
    expect(() => svc.assertUsable("claude")).toThrow(ProviderCliMissingError);
  });

  it("does not throw when enabled and CLI found", async () => {
    const svc = new ProviderAvailabilityService(
      stubSettings(),
      stubRegistry(["claude"]),
      { which: vi.fn(async () => "/usr/local/bin/claude"), statExecutable: vi.fn() },
    );
    await svc.verifyCli("claude");
    expect(() => svc.assertUsable("claude")).not.toThrow();
  });

  it("does not throw when enabled + adapter present but CLI unchecked (startup race)", () => {
    const svc = new ProviderAvailabilityService(stubSettings(), stubRegistry(["claude"]));
    expect(() => svc.assertUsable("claude")).not.toThrow();
  });
});

describe("ProviderAvailabilityService.verifyAllEnabled", () => {
  it("verifies only providers with enabled=true and hasAdapter=true", async () => {
    const s = getDefaultSettings();
    s.provider.enabled.copilot = false;
    const which = vi.fn(async (bin: string) => `/usr/local/bin/${bin}`);
    const svc = new ProviderAvailabilityService(
      { get: () => s, on: () => {} } as unknown as SettingsService,
      stubRegistry(["claude", "codex", "copilot"]),
      { which, statExecutable: vi.fn() },
    );
    await svc.verifyAllEnabled();
    expect(which).toHaveBeenCalledWith("claude");
    expect(which).toHaveBeenCalledWith("codex");
    expect(which).not.toHaveBeenCalledWith("copilot");
  });
});

describe("ProviderAvailabilityService change handling", () => {
  it("re-verifies when provider.enabled changes and calls the broadcast hook", async () => {
    const listeners: Array<(s: ReturnType<typeof getDefaultSettings>) => void> = [];
    const settingsStore = { current: getDefaultSettings() };
    const settings = {
      get: () => settingsStore.current,
      on: (_: string, cb: (s: ReturnType<typeof getDefaultSettings>) => void) => listeners.push(cb),
    } as unknown as SettingsService;

    const broadcastSpy = vi.fn();
    const which = vi.fn(async (bin: string) => `/usr/local/bin/${bin}`);
    const svc = new ProviderAvailabilityService(
      settings,
      stubRegistry(["claude", "codex"]),
      { which, statExecutable: vi.fn() },
    );
    svc.onChange(broadcastSpy);

    // Flip codex off.
    settingsStore.current = {
      ...settingsStore.current,
      provider: {
        ...settingsStore.current.provider,
        enabled: { ...settingsStore.current.provider.enabled, codex: false },
      },
    };
    for (const cb of listeners) cb(settingsStore.current);
    await new Promise((r) => setTimeout(r, 0));

    expect(broadcastSpy).toHaveBeenCalled();
    const lastList = broadcastSpy.mock.calls.at(-1)![0];
    expect(lastList.find((p: ProviderAvailability) => p.id === "codex").enabled).toBe(false);
  });
});
