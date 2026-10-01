/**
 * Tests for ModelCacheService — verifies stale-while-revalidate semantics,
 * SQLite hydration at construction time, and write-elision on unchanged
 * model lists.
 */

import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock("../../../../application/transport/push.js", () => ({
  broadcast: broadcastMock,
}));
import type { Database } from "bun:sqlite";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { ModelCacheRepo } from "../persistence/model-cache-repo.js";
import { ModelCacheService, startupModelProviderIds } from "../model-cache-service.js";
import type { ProviderAvailability, ProviderId, ProviderModelInfo, IProviderRegistry } from "@mcode/contracts";

function availableProvider(id: ProviderId, enabled: boolean): ProviderAvailability {
  return {
    id, enabled, hasAdapter: true, beta: false, comingSoon: false, capabilities: [],
    cli: { status: "found", resolvedPath: id, configuredPath: "" },
  };
}

function makeProvider(models: ProviderModelInfo[], id = "test-provider") {
  return {
    id,
    listModels: vi.fn().mockResolvedValue(models),
    sendTurn: vi.fn(),
    cancelSession: vi.fn(),
    shutdown: vi.fn(),
  };
}

function makeRegistry(
  providers: Map<string, ReturnType<typeof makeProvider> | { id: string }>,
): IProviderRegistry {
  return {
    resolve: (id: string) => {
      const p = providers.get(id);
      if (!p) throw new Error(`No provider: ${id}`);
      return p as never;
    },
    resolveAll: () => [...providers.values()] as never[],
    shutdown: vi.fn(),
  };
}

describe("ModelCacheService", () => {
  let db: Database;
  let repo: ModelCacheRepo;
  let owned: OwnedTestDatabase;
  const services: ModelCacheService[] = [];
  function createService(registry: IProviderRegistry): ModelCacheService {
    const service = new ModelCacheService(repo, registry);
    services.push(service);
    return service;
  }

  beforeEach(() => {
    broadcastMock.mockClear();
    owned = createOwnedTestDatabase();
    db = owned.db;
    repo = new ModelCacheRepo(db, owned.writer);
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    await owned.close();
  });

  it("warms enabled providers without starting idle OpenCode", async () => {
    const claude = makeProvider([{ id: "claude-model", name: "Claude Model" }], "claude");
    const opencode = makeProvider([{ id: "open-model", name: "Open Model" }], "opencode");
    const codex = makeProvider([{ id: "codex-model", name: "Codex Model" }], "codex");
    const registry = makeRegistry(new Map([["claude", claude], ["opencode", opencode], ["codex", codex]]));
    const service = createService(registry);

    const startupProviders = startupModelProviderIds([
      availableProvider("claude", true),
      availableProvider("opencode", true),
      availableProvider("codex", false),
    ]);
    expect(startupProviders).toEqual(["claude"]);
    await service.refreshProviders(startupProviders);

    expect(service.getCached("claude")).toEqual([{ id: "claude-model", name: "Claude Model" }]);
    expect(service.getCached("opencode")).toBeUndefined();
    expect(opencode.listModels).not.toHaveBeenCalled();
    expect(codex.listModels).not.toHaveBeenCalled();
  });

  it("returns cached models without calling provider when cache is fresh", async () => {
    const models: ProviderModelInfo[] = [{ id: "m1", name: "Model 1" }];
    await repo.upsert("test-provider", models);

    const provider = makeProvider([{ id: "m1", name: "Model 1 Updated" }]);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = createService(registry);

    const result = await service.listModels("test-provider");
    expect(result).toEqual(models);
    // Provider should NOT have been called because cache is fresh
    expect(provider.listModels).not.toHaveBeenCalled();
  });

  it("fetches from provider when no cache exists", async () => {
    const models: ProviderModelInfo[] = [{ id: "m1", name: "Model 1" }];
    const provider = makeProvider(models);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = createService(registry);

    const result = await service.listModels("test-provider");
    expect(result).toEqual(models);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it("persists fetched models to SQLite", async () => {
    const models: ProviderModelInfo[] = [{ id: "m1", name: "Model 1" }];
    const provider = makeProvider(models);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = createService(registry);

    await service.listModels("test-provider");

    const cached = repo.get("test-provider");
    expect(cached).not.toBeNull();
    expect(cached!.models).toEqual(models);
  });

  it("loads all cached entries into memory at construction", async () => {
    await repo.upsert("cursor", [{ id: "c1", name: "Cursor Model" }]);
    await repo.upsert("copilot", [{ id: "p1", name: "Copilot Model" }]);

    const registry = makeRegistry(new Map());
    const service = createService(registry);

    // Both should be available from in-memory cache without provider calls
    expect(service.getCached("cursor")).toEqual([{ id: "c1", name: "Cursor Model" }]);
    expect(service.getCached("copilot")).toEqual([{ id: "p1", name: "Copilot Model" }]);
  });

  it("does not write to SQLite when model lists are unchanged", async () => {
    const models: ProviderModelInfo[] = [
      { id: "m1", name: "Model 1" },
      { id: "m2", name: "Model 2" },
    ];
    await repo.upsert("test-provider", models);

    const provider = makeProvider(models);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = createService(registry);

    // Spy on repo.upsert to confirm it's not called when IDs match
    const upsertSpy = vi.spyOn(repo, "upsert");

    // Force a refresh
    await service.refreshProvider("test-provider");

    // The provider was called, but since IDs match, upsert should not run
    expect(provider.listModels).toHaveBeenCalledTimes(1);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("broadcasts provider.modelsChanged when a refresh changes the list", async () => {
    await repo.upsert("devin", [{ id: "swe-1-7", name: "SWE-1.7" }]);
    const fresh: ProviderModelInfo[] = [{ id: "swe-2", name: "SWE-2" }];
    const provider = makeProvider(fresh);
    const registry = makeRegistry(new Map([["devin", provider]]));
    const service = createService(registry);

    await service.refreshProvider("devin");

    expect(broadcastMock).toHaveBeenCalledWith("provider.modelsChanged", {
      providerId: "devin",
      models: fresh,
    });
  });

  it("does not broadcast when a refresh returns an unchanged list", async () => {
    const models: ProviderModelInfo[] = [{ id: "swe-2", name: "SWE-2" }];
    await repo.upsert("devin", models);
    const provider = makeProvider(models);
    const registry = makeRegistry(new Map([["devin", provider]]));
    const service = createService(registry);

    await service.refreshProvider("devin");

    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("persists changed order and labels across cache reconstruction", async () => {
    await repo.upsert("test-provider", [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    const provider = makeProvider([{ id: "b", name: "Bee" }, { id: "a", name: "A" }]);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    await createService(registry).refreshProvider("test-provider");
    expect(await createService(registry).listModels("test-provider")).toEqual([
      { id: "b", name: "Bee" }, { id: "a", name: "A" },
    ]);
  });

  it("updates SQLite when provider returns different model IDs", async () => {
    await repo.upsert("test-provider", [{ id: "old", name: "Old" }]);

    const newModels: ProviderModelInfo[] = [{ id: "new", name: "New" }];
    const provider = makeProvider(newModels);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = createService(registry);

    await service.refreshProvider("test-provider");

    const cached = repo.get("test-provider");
    expect(cached!.models).toEqual(newModels);
  });

  it("invalidate clears memory and SQLite so the next read refetches", async () => {
    await repo.upsert("cursor", [{ id: "c1", name: "Cached" }]);
    const fresh: ProviderModelInfo[] = [{ id: "c2", name: "Fresh" }];
    const provider = makeProvider(fresh);
    const registry = makeRegistry(new Map([["cursor", provider]]));
    const service = createService(registry);

    expect(service.getCached("cursor")).toEqual([{ id: "c1", name: "Cached" }]);

    await service.invalidate("cursor");

    expect(service.getCached("cursor")).toBeUndefined();
    expect(repo.get("cursor")).toBeNull();

    const result = await service.listModels("cursor");
    expect(result).toEqual(fresh);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it("invalidate during in-flight refresh does not repopulate cache", async () => {
    let resolveList!: (value: ProviderModelInfo[]) => void;
    const listPromise = new Promise<ProviderModelInfo[]>((resolve) => {
      resolveList = resolve;
    });
    const stale: ProviderModelInfo[] = [{ id: "stale", name: "Stale" }];
    const provider = {
      id: "cursor",
      listModels: vi.fn().mockReturnValue(listPromise),
      sendTurn: vi.fn(),
      cancelSession: vi.fn(),
      shutdown: vi.fn(),
    };
    await repo.upsert("cursor", [{ id: "seed", name: "Seed" }]);
    const registry = makeRegistry(new Map([["cursor", provider]]));
    const service = createService(registry);

    expect(service.getCached("cursor")).toEqual([{ id: "seed", name: "Seed" }]);

    const refreshDone = service.refreshProvider("cursor");

    await service.invalidate("cursor");

    expect(service.getCached("cursor")).toBeUndefined();
    expect(repo.get("cursor")).toBeNull();

    resolveList(stale);
    await refreshDone;

    expect(service.getCached("cursor")).toBeUndefined();
    expect(repo.get("cursor")).toBeNull();
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it("throws when fetching from a provider that does not implement listModels", async () => {
    const provider = {
      id: "no-list",
      sendTurn: vi.fn(),
      cancelSession: vi.fn(),
      shutdown: vi.fn(),
    };
    const registry = makeRegistry(new Map([["no-list", provider]]));
    const service = createService(registry);

    await expect(service.listModels("no-list")).rejects.toThrow();
  });

  it("drains an external fetch and its real SQLite save before closing while keeping cache reads", async () => {
    let finish!: (models: ProviderModelInfo[]) => void;
    const fetched = new Promise<ProviderModelInfo[]>((resolve) => { finish = resolve; });
    const models = [{ id: "fresh", name: "Fresh" }];
    const provider = makeProvider(models);
    provider.listModels.mockReturnValue(fetched);
    const service = createService(makeRegistry(new Map([["test-provider", provider]])));
    const refresh = service.refreshProvider("test-provider");
    const settled = vi.fn();
    const closed = service.close().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    await expect(service.refreshProvider("test-provider")).rejects.toThrow("closed");
    finish(models);
    await refresh;
    await closed;
    expect(repo.get("test-provider")?.models).toEqual(models);
    expect(await service.listModels("test-provider")).toEqual(models);
    expect(service.getCached("test-provider")).toEqual(models);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it("still drains a fetch removed from the coalescing map by invalidation", async () => {
    let finish!: (models: ProviderModelInfo[]) => void;
    const provider = makeProvider([]);
    provider.listModels.mockReturnValue(new Promise<ProviderModelInfo[]>((resolve) => { finish = resolve; }));
    const service = createService(makeRegistry(new Map([["test-provider", provider]])));
    const refresh = service.refreshProvider("test-provider");
    await service.invalidate("test-provider");
    const settled = vi.fn();
    const closed = service.close().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    finish([{ id: "stale", name: "Stale" }]);
    await refresh;
    await closed;
    expect(repo.get("test-provider")).toBeNull();
    expect(service.getCached("test-provider")).toBeUndefined();
  });
});
