import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentEventType,
  SettingsSchema,
  type ProviderId,
  type ProviderStatusFacts,
  type ProviderCliFacts,
  type Settings,
} from "@mcode/contracts";
import { describeDevinAuth } from "@mcode/providers";
import { ProviderRateLimitStore } from "../provider-rate-limit-store.js";
import { ProviderStatusService, recheckAfterAuthFailure, type StatusSourceRegistry } from "../provider-status-service.js";
import { NpmReleaseFeed } from "../npm-release-feed.js";
import { CliUpdateRunner, type CliUpdateProcessHost } from "../cli-update-runner.js";
import { ModelSightingsRepo } from "../model-sightings-repo.js";
import { ModelCacheService } from "../../models/model-cache-service.js";
import { ModelCacheRepo } from "../../models/persistence/model-cache-repo.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock("../../../../application/transport/push.js", () => ({ broadcast: broadcastMock }));

const SIGNED_IN: ProviderStatusFacts = { auth: { state: "signed_in" } };
let owned: OwnedTestDatabase;
let sightings: ModelSightingsRepo;
let cacheRepo: ModelCacheRepo;
const caches: ModelCacheService[] = [];

function makeSettings(enabled: Partial<Settings["provider"]["enabled"]>): Settings {
  const settings = SettingsSchema().parse({});
  settings.provider.enabled = { ...settings.provider.enabled, ...enabled };
  return settings;
}

function makeService(
  enabled: Partial<Settings["provider"]["enabled"]>,
  sources: Array<{ id: ProviderId; describeStatus?: () => Promise<ProviderStatusFacts> }>,
  rateLimits = new ProviderRateLimitStore(),
): ProviderStatusService {
  const settings = makeSettings(enabled);
  const registry: StatusSourceRegistry = { resolveAll: () => sources };
  return new ProviderStatusService({ get: () => settings, on: () => () => undefined }, registry, rateLimits, sightings, makeCache());
}

function makeCache(): ModelCacheService {
  const cache = new ModelCacheService(cacheRepo, {
    resolve: () => { throw new Error("No model fetch expected"); },
    resolveAll: () => [],
    shutdown: async () => {},
  }, sightings);
  caches.push(cache);
  return cache;
}

function pushedStatuses(): unknown[] {
  return broadcastMock.mock.calls.map(([channel, status]) => {
    expect(channel).toBe("providers.statusChanged");
    return status;
  });
}

function cliFixture() {
  const settings = makeSettings({ codex: true, claude: true });
  let listener: (next: Settings) => void = () => {};
  const cli: ProviderCliFacts = {
    installed: "1.0.0", managedBy: "user", resolvedPath: "/scratch/npm/bin/codex", npmPackage: "@openai/codex",
  };
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ version: "1.1.0" })));
  const processRun = vi.fn<CliUpdateProcessHost["run"]>(async (args) => {
    if (args[0] === "prefix") return { kind: "exited", code: 0, output: "/scratch/npm" };
    cli.installed = "1.1.0";
    return { kind: "exited", code: 0, output: "" };
  });
  const clearCliVersionCache = vi.fn();
  const sources = [
    { id: "codex" as const, describeStatus: async () => ({ ...SIGNED_IN, cli: { ...cli } }), clearCliVersionCache },
    { id: "claude" as const, describeStatus: async () => ({ ...SIGNED_IN, cli: {
      installed: null, managedBy: "mcode" as const, resolvedPath: null, npmPackage: "@anthropic-ai/claude-code",
    } }) },
  ];
  const service = new ProviderStatusService({
    get: () => settings,
    on: (_event, cb) => { listener = cb; return () => {}; },
  }, { resolveAll: () => sources }, new ProviderRateLimitStore(), sightings, makeCache(), new NpmReleaseFeed(request), new CliUpdateRunner({ platform: "linux", run: processRun }));
  return { service, settings, cli, request, processRun, clearCliVersionCache, change: () => listener(settings) };
}

describe("ProviderStatusService CLI updates", () => {
  it("caches independently per package with the injected clock", async () => {
    let now = 0;
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ version: "2.0.0" })));
    const feed = new NpmReleaseFeed(request, () => now);
    expect(await Promise.all([feed.latest("@openai/codex"), feed.latest("@openai/codex"), feed.latest("opencode-ai")])).toEqual(["2.0.0", "2.0.0", "2.0.0"]);
    expect(request).toHaveBeenCalledTimes(2);
    now = 86_399_999;
    expect(await feed.latest("@openai/codex")).toBe("2.0.0");
    expect(request).toHaveBeenCalledTimes(2);
    now = 86_400_000;
    expect(await feed.latest("@openai/codex")).toBe("2.0.0");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not publish an update if checks turn off during a registry request", async () => {
    const { service, settings, request, change } = cliFixture();
    let complete: (response: Response) => void = () => {};
    request.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = service.listStatus();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    settings.updates.providerCliChecks = false;
    change();
    complete(new Response(JSON.stringify({ version: "1.1.0" })));
    expect((await pending).find((s) => s.providerId === "codex")?.cli).toEqual({
      installed: "1.0.0", managedBy: "user", latest: null, update: { state: "none" },
    });
    expect(broadcastMock.mock.calls.filter(([, status]) => status.cli?.update.state === "available")).toEqual([]);
  });
  it("caches registry results for 24 hours, encodes scoped packages and never checks bundled Claude", async () => {
    vi.useFakeTimers({ now: 0 });
    const { service, request } = cliFixture();
    const first = await service.listStatus();
    expect([first.find((s) => s.providerId === "codex")?.cli, first.find((s) => s.providerId === "claude")?.cli]).toEqual([
      { installed: "1.0.0", managedBy: "user", latest: "1.1.0", update: { state: "available", target: "1.1.0" } },
      { installed: null, managedBy: "mcode", latest: null, update: { state: "none" } },
    ]);
    broadcastMock.mockClear();
    await service.refresh();
    expect(request.mock.calls.map(([url]) => url)).toEqual(["https://registry.npmjs.org/%40openai%2Fcodex/latest"]);
    expect(pushedStatuses()).toEqual([]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await service.refresh();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("times out the registry after five seconds, caches the failure, and exposes no error", async () => {
    vi.useFakeTimers();
    const { service, request } = cliFixture();
    request.mockImplementation(() => new Promise(() => {}));
    const pending = service.listStatus();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).find((s) => s.providerId === "codex")?.cli).toEqual({
      installed: "1.0.0", managedBy: "user", latest: null, update: { state: "none" },
    });
    await service.refresh();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { version: "latest" }, { version: 12 }])("ignores malformed registry releases: %j", async (body) => {
    const { service, request } = cliFixture();
    request.mockResolvedValue(new Response(JSON.stringify(body)));
    expect((await service.listStatus()).find((s) => s.providerId === "codex")?.cli?.update).toEqual({ state: "none" });
  });

  it("makes zero registry requests with checks off", async () => {
    const { service, settings, request, processRun } = cliFixture();
    settings.updates.providerCliChecks = false;
    expect((await service.listStatus()).find((s) => s.providerId === "codex")?.cli).toEqual({
      installed: "1.0.0", managedBy: "user", latest: null, update: { state: "none" },
    });
    await expect(service.updateCli("codex")).rejects.toThrow();
    expect(request.mock.calls).toEqual([]);
    expect(processRun.mock.calls).toEqual([]);
  });

  it("refreshes and pushes when checks change without waiting for the cache", async () => {
    const { service, settings, change } = cliFixture();
    await service.listStatus();
    settings.updates.providerCliChecks = false;
    change();
    await vi.waitFor(() => expect(broadcastMock.mock.calls.at(-1)?.[1].cli).toEqual({
      installed: "1.0.0", managedBy: "user", latest: null, update: { state: "none" },
    }));
    settings.updates.providerCliChecks = true;
    change();
    await vi.waitFor(() => expect(broadcastMock.mock.calls.at(-1)?.[1].cli.update).toEqual({ state: "available", target: "1.1.0" }));
  });

  it("shows no update for an outside-prefix CLI and rejects direct update requests", async () => {
    const { service, cli, processRun } = cliFixture();
    cli.resolvedPath = "/other/codex";
    expect((await service.listStatus()).find((s) => s.providerId === "codex")?.cli?.update).toEqual({ state: "none" });
    await expect(service.updateCli("codex")).rejects.toThrow();
    expect(processRun.mock.calls.map(([args]) => args)).toEqual([["prefix", "-g"], ["prefix", "-g"]]);
  });

  it("retains a bounded failure across refreshes and allows a successful retry", async () => {
    const { service, cli, processRun, clearCliVersionCache } = cliFixture();
    processRun.mockImplementation(async (args) => args[0] === "prefix"
      ? { kind: "exited", code: 0, output: "/scratch/npm" }
      : { kind: "exited", code: 1, output: "x".repeat(500) });
    const failed = await service.updateCli("codex");
    expect(failed.cli?.update).toEqual({ state: "failed", target: "1.1.0", reason: "x".repeat(240) });
    expect((await service.listStatus({ force: true })).find((s) => s.providerId === "codex")?.cli?.update).toEqual(failed.cli?.update);
    expect(clearCliVersionCache).toHaveBeenCalledTimes(0);
    processRun.mockImplementation(async (args) => {
      if (args[0] === "prefix") return { kind: "exited", code: 0, output: "/scratch/npm" };
      cli.installed = "1.1.0";
      return { kind: "exited", code: 0, output: "" };
    });
    expect((await service.updateCli("codex")).cli?.update).toEqual({ state: "none" });
    expect(clearCliVersionCache).toHaveBeenCalledTimes(1);
  });

  it("shares one update, keeps running across refreshes, clears the cache and removes the row on success", async () => {
    const { service, processRun, cli, clearCliVersionCache } = cliFixture();
    let complete: () => void = () => {};
    const installed = new Promise<void>((resolve) => { complete = resolve; });
    processRun.mockImplementation(async (args) => {
      if (args[0] === "prefix") return { kind: "exited", code: 0, output: "/scratch/npm" };
      await installed;
      cli.installed = "1.1.0";
      return { kind: "exited", code: 0, output: "" };
    });
    const first = service.updateCli("codex");
    const second = service.updateCli("codex");
    expect(first).toBe(second);
    await vi.waitFor(() => expect(processRun.mock.calls.filter(([args]) => args[0] === "install")).toHaveLength(1));
    expect((await service.listStatus({ force: true })).find((s) => s.providerId === "codex")?.cli?.update).toEqual({ state: "running", target: "1.1.0" });
    complete();
    expect((await first).cli).toEqual({
      installed: "1.1.0", managedBy: "user", latest: "1.1.0", update: { state: "none" },
    });
    expect(clearCliVersionCache).toHaveBeenCalledTimes(1);
  });
});

beforeEach(() => {
  broadcastMock.mockReset();
  owned = createOwnedTestDatabase();
  sightings = new ModelSightingsRepo(owned.db, owned.writer);
  cacheRepo = new ModelCacheRepo(owned.db, owned.writer);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const cache of caches.splice(0)) await cache.close();
  await owned.close();
});

describe("ProviderStatusService with the real Devin check", () => {
  let home: string;

  beforeEach(async () => {
    home = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-status-"));
  });

  afterEach(async () => {
    await NodeFSPromises.rm(home, { recursive: true, force: true });
  });

  function devinWith(extraEnv: Record<string, string>) {
    const env = { HOME: home, USERPROFILE: home, APPDATA: home, XDG_DATA_HOME: home, ...extraEnv };
    return { id: "devin" as const, describeStatus: async () => describeDevinAuth(env, process.platform) };
  }

  it("reports signed out with the login command when no credentials exist", async () => {
    const statuses = await makeService({ devin: true }, [devinWith({})]).listStatus();
    expect(statuses).toEqual([
      expect.objectContaining({
        providerId: "devin",
        auth: { state: "signed_out", signIn: { kind: "terminal", argv: ["devin", "auth", "login"] } },
        rateLimit: null,
      }),
    ]);
  });

  it("reports signed in when an API key is set", async () => {
    const statuses = await makeService({ devin: true }, [devinWith({ DEVIN_API_KEY: "placeholder" })]).listStatus();
    expect(statuses[0]?.auth).toEqual({ state: "signed_in" });
  });
});

describe("ProviderStatusService refresh", () => {
  it("keeps the last known auth for a provider whose check throws while others update", async () => {
    let claudeFacts: ProviderStatusFacts = SIGNED_IN;
    let codexFails = false;
    const service = makeService({ claude: true, codex: true, cursor: false }, [
      { id: "claude", describeStatus: async () => claudeFacts },
      {
        id: "codex",
        describeStatus: async () => {
          if (codexFails) throw new Error("boom");
          return SIGNED_IN;
        },
      },
      { id: "cursor", describeStatus: async () => SIGNED_IN },
    ]);

    await service.refresh();
    claudeFacts = { auth: { state: "signed_out", signIn: { kind: "terminal", argv: ["claude"] } } };
    codexFails = true;
    broadcastMock.mockReset();
    const statuses = await service.listStatus({ force: true });

    expect(statuses.map((status) => [status.providerId, status.auth.state])).toEqual([
      ["claude", "signed_out"],
      ["codex", "signed_in"],
    ]);
    expect(pushedStatuses()).toEqual([expect.objectContaining({ providerId: "claude" })]);
  });

  it("reports unknown for a provider without a check or whose first check throws", async () => {
    const statuses = await makeService({ claude: true, codex: true }, [
      { id: "claude" },
      { id: "codex", describeStatus: async () => { throw new Error("boom"); } },
    ]).listStatus();
    expect(statuses.map((status) => status.auth)).toEqual([{ state: "unknown" }, { state: "unknown" }]);
  });

  it("gives up on a hung check after 30 seconds so the refresh still settles", async () => {
    vi.useFakeTimers();
    const service = makeService({ claude: true, copilot: true }, [
      { id: "claude", describeStatus: async () => SIGNED_IN },
      { id: "copilot", describeStatus: () => new Promise<ProviderStatusFacts>(() => {}) },
    ]);

    const pending = service.listStatus();
    await vi.advanceTimersByTimeAsync(30_000);
    const statuses = await pending;

    expect(statuses.map((status) => [status.providerId, status.auth.state])).toEqual([
      ["claude", "signed_in"],
      ["copilot", "unknown"],
    ]);
  });

  it("serves the cache for 10 minutes unless forced", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T12:00:00Z") });
    const describeStatus = vi.fn(async () => SIGNED_IN);
    const service = makeService({ claude: true }, [{ id: "claude", describeStatus }]);

    await service.listStatus();
    vi.advanceTimersByTime(9 * 60 * 1000);
    await service.listStatus();
    expect(describeStatus).toHaveBeenCalledTimes(1);

    await service.listStatus({ force: true });
    expect(describeStatus).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10 * 60 * 1000);
    await service.listStatus();
    expect(describeStatus).toHaveBeenCalledTimes(3);
  });
});

describe("ProviderStatusService recheck", () => {
  const CLAUDE_SIGNED_OUT: ProviderStatusFacts = {
    auth: { state: "signed_out", signIn: { kind: "terminal", argv: ["claude", "/login"] } },
  };

  it("re-describes only that provider and publishes its new auth state", async () => {
    let claudeFacts: ProviderStatusFacts = SIGNED_IN;
    const describeClaude = vi.fn(async () => claudeFacts);
    const describeCodex = vi.fn(async () => SIGNED_IN);
    const service = makeService({ claude: true, codex: true }, [
      { id: "claude", describeStatus: describeClaude },
      { id: "codex", describeStatus: describeCodex },
    ]);
    await service.refresh();
    broadcastMock.mockReset();
    claudeFacts = CLAUDE_SIGNED_OUT;

    await Promise.all([service.recheck("claude"), service.recheck("claude")]);

    expect(describeClaude).toHaveBeenCalledTimes(2);
    expect(describeCodex).toHaveBeenCalledTimes(1);
    expect(pushedStatuses()).toEqual([
      expect.objectContaining({
        providerId: "claude",
        auth: { state: "signed_out", signIn: { kind: "terminal", argv: ["claude", "/login"] } },
      }),
    ]);
  });

  it("does nothing for a disabled provider", async () => {
    const describeStatus = vi.fn(async () => SIGNED_IN);
    const service = makeService({ claude: false }, [{ id: "claude", describeStatus }]);

    await service.recheck("claude");

    expect(describeStatus).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("observes auth Error events only", () => {
    const recheck = vi.fn(async (_providerId: ProviderId) => {});
    const observe = recheckAfterAuthFailure({ recheck });
    const failed = (kind: "auth" | "fatal") => ({
      type: AgentEventType.Error, threadId: "t1", error: "failed", failure: { kind },
    } as const);

    observe({ providerId: "codex", sourceKind: "provider-runtime", event: failed("fatal") });
    observe({ providerId: "codex", sourceKind: "provider-runtime", event: { type: AgentEventType.RateLimited, threadId: "t1", active: true } });
    expect(recheck).not.toHaveBeenCalled();

    observe({ providerId: "codex", sourceKind: "provider-runtime", event: failed("auth") });
    expect(recheck.mock.calls).toEqual([["codex"]]);
  });
});

describe("ProviderStatusService rate limits", () => {
  it("pushes a limit when it starts, when it lifts, and when its reset time passes", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T12:00:00Z") });
    const rateLimits = new ProviderRateLimitStore();
    const service = makeService({ claude: true }, [{ id: "claude", describeStatus: async () => SIGNED_IN }], rateLimits);
    await service.refresh();
    broadcastMock.mockReset();

    const limited = { type: AgentEventType.RateLimited, threadId: "t1", active: true, limitType: "five_hour" };
    rateLimits.record("claude", { ...limited, retryAfterMs: 60_000 });
    rateLimits.record("claude", { ...limited, active: false });
    rateLimits.record("claude", { ...limited, retryAfterMs: 30_000 });
    vi.advanceTimersByTime(30_000);

    expect(pushedStatuses()).toEqual([
      expect.objectContaining({ rateLimit: { resetsAt: "2026-01-01T12:01:00.000Z", limitType: "five_hour" } }),
      expect.objectContaining({ rateLimit: null }),
      expect.objectContaining({ rateLimit: { resetsAt: "2026-01-01T12:00:30.000Z", limitType: "five_hour" } }),
      expect.objectContaining({ rateLimit: null }),
    ]);
    expect((await service.listStatus())[0]?.auth).toEqual({ state: "signed_in" });
  });

  it("ignores limits for a disabled provider", () => {
    const rateLimits = new ProviderRateLimitStore();
    makeService({ claude: false }, [], rateLimits);
    rateLimits.record("claude", { active: true, retryAfterMs: 60_000 });
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe("ProviderStatusService model announcements", () => {
  it("filters missing models, limits to five newest sightings and falls back to the model id", async () => {
    await sightings.record("claude", ["baseline"], "2026-01-01T00:00:00.000Z");
    await sightings.record("claude", ["a", "b", "c", "d", "e"], "2026-01-02T00:00:00.000Z");
    await sightings.record("claude", ["f", "missing"], "2026-01-03T00:00:00.000Z");
    await cacheRepo.upsert("claude", [
      { id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" },
      { id: "d", name: "D" }, { id: "e", name: "E" }, { id: "f", name: "" },
    ]);
    const service = makeService({ claude: true }, [{ id: "claude" }]);
    expect((await service.listStatus())[0]?.newModels).toEqual([
      { modelId: "f", label: "f" }, { modelId: "a", label: "A" },
      { modelId: "b", label: "B" }, { modelId: "c", label: "C" }, { modelId: "d", label: "D" },
    ]);
    broadcastMock.mockClear();
    await service.refresh();
    expect(pushedStatuses()).toEqual([]);
    await service.acknowledgeModels("claude");
    expect(pushedStatuses()).toEqual([expect.objectContaining({ providerId: "claude", newModels: [] })]);
    await service.acknowledgeModels("claude");
    expect(pushedStatuses()).toHaveLength(1);
  });

  it("never publishes announcements for OpenCode or a disabled provider", async () => {
    for (const providerId of ["opencode", "claude"] as const) {
      await sightings.record(providerId, ["baseline"], "2026-01-01T00:00:00.000Z");
      await cacheRepo.upsert(providerId, [{ id: "new", name: "New" }]);
    }
    const service = makeService({ claude: false, opencode: true }, [{ id: "claude" }, { id: "opencode" }]);
    await service.refresh();
    broadcastMock.mockClear();
    for (const providerId of ["opencode", "claude"] as const) {
      await sightings.record(providerId, ["new"], "2026-01-02T00:00:00.000Z");
    }
    expect(pushedStatuses()).toEqual([]);
    expect((await service.listStatus()).map(({ providerId, newModels }) => ({ providerId, newModels })))
      .toEqual([{ providerId: "opencode", newModels: [] }]);
  });
});
