import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container, type DependencyContainer } from "tsyringe";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { CLAUDE_STATIC_MODELS, SettingsSchema, type ProviderId, type ProviderModelInfo } from "@mcode/contracts";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { providerModelSightings } from "../../../../runtime/persistence/sqlite/schema.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { registerProviderRepositories } from "../../composition/register-provider-repositories.js";
import { registerProviderRuntimeServices } from "../../composition/register-provider-services.js";
import { ModelCacheRepo } from "../../models/persistence/model-cache-repo.js";
import { ModelCacheService } from "../../models/model-cache-service.js";
import { ModelSightingsRepo } from "../model-sightings-repo.js";
import { ProviderStatusService } from "../provider-status-service.js";

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock("../../../../application/transport/push.js", () => ({ broadcast: broadcastMock }));

const BASELINE_AT = "2026-01-01T00:00:00.000Z";
const LAUNCH_AT = "2026-01-02T00:00:00.000Z";

describe("model sightings with SQLite and the application writer", () => {
  let owned: OwnedTestDatabase;
  let scope: DependencyContainer;
  let sightings: ModelSightingsRepo;
  let cache: ModelCacheService;
  let status: ProviderStatusService;
  const catalogs = new Map<ProviderId, ProviderModelInfo[]>();
  let failFetch = false;

  beforeEach(() => {
    owned = createOwnedTestDatabase();
    scope = container.createChildContainer();
    catalogs.clear();
    catalogs.set("claude", [...CLAUDE_STATIC_MODELS]);
    catalogs.set("opencode", [{ id: "upstream-old", name: "Upstream old" }]);
    failFetch = false;
    const sources = [...catalogs.keys()].map((id) => ({
      id,
      listModels: async () => {
        if (failFetch) throw new Error("Catalog unavailable");
        return catalogs.get(id) ?? [];
      },
    }));
    const settings = SettingsSchema().parse({});
    settings.provider.enabled.claude = true;
    settings.provider.enabled.opencode = true;
    scope.register("Database", { useValue: owned.db });
    scope.register(ApplicationDatabaseWriter, { useValue: owned.writer });
    scope.register(SettingsService, { useValue: { get: () => settings, on: () => () => undefined } });
    scope.register("IProviderRegistry", { useValue: {
      resolve: (id: ProviderId) => {
        const source = sources.find((provider) => provider.id === id);
        if (!source) throw new Error(`Unknown provider ${id}`);
        return source;
      },
      resolveAll: () => sources,
    } });
    registerProviderRepositories(scope);
    registerProviderRuntimeServices(scope);
    sightings = scope.resolve(ModelSightingsRepo);
    broadcastMock.mockClear();
  });

  afterEach(async () => {
    await cache?.close();
    await owned.close();
    scope.reset();
  });

  function startServices(): void {
    cache = scope.resolve(ModelCacheService);
    status = scope.resolve(ProviderStatusService);
  }

  function rows(providerId: ProviderId) {
    return drizzle(owned.db).select().from(providerModelSightings)
      .where(eq(providerModelSightings.providerId, providerId)).all();
  }

  async function announcements(providerId: ProviderId = "claude") {
    return (await status.listStatus()).find((entry) => entry.providerId === providerId)?.newModels;
  }

  it("baselines every current model even when the identical cache was persisted before upgrading", async () => {
    await scope.resolve(ModelCacheRepo).upsert("claude", [...CLAUDE_STATIC_MODELS]);
    startServices();
    await cache.refreshProvider("claude");
    expect(rows("claude").map(({ modelId }) => modelId).sort()).toEqual(CLAUDE_STATIC_MODELS.map(({ id }) => id).sort());
    expect(rows("claude").every((row) => row.acknowledgedAt === row.firstSeenAt)).toBe(true);
    expect(await announcements()).toEqual([]);
  });

  it("announces one added Claude static model, acknowledges it, and never reopens it after refresh or reconstruction", async () => {
    startServices();
    await cache.refreshProvider("claude");
    await status.listStatus();
    broadcastMock.mockClear();
    const launched = { id: "claude-fixture-next", name: "Claude Fixture Next" };
    catalogs.set("claude", [...CLAUDE_STATIC_MODELS, launched]);
    await cache.refreshProvider("claude");
    expect(await announcements()).toEqual([{ modelId: launched.id, label: launched.name }]);
    expect(broadcastMock.mock.calls.filter(([channel]) => channel === "providers.statusChanged"))
      .toEqual([["providers.statusChanged", expect.objectContaining({ providerId: "claude", newModels: [{ modelId: launched.id, label: launched.name }] })]]);
    await status.acknowledgeModels("claude");
    expect(await announcements()).toEqual([]);
    await cache.refreshProvider("claude");
    expect(await announcements()).toEqual([]);
    const reconstructed = new ModelSightingsRepo(owned.db, owned.writer);
    await reconstructed.record("claude", [launched.id], "2026-01-03T00:00:00.000Z");
    expect(reconstructed.listOpen("claude")).toEqual([]);
    expect(rows("claude").filter((row) => row.modelId === launched.id)).toHaveLength(1);
  });

  it("excludes OpenCode even when its upstream catalog gains a model", async () => {
    startServices();
    await cache.refreshProvider("opencode");
    catalogs.set("opencode", [{ id: "upstream-new", name: "Upstream new" }]);
    await cache.refreshProvider("opencode");
    expect(rows("opencode")).toEqual([]);
    expect(await announcements("opencode")).toEqual([]);
  });

  it("skips empty and failed first fetches so the next nonempty catalog is still the baseline", async () => {
    startServices();
    failFetch = true;
    await expect(cache.refreshProvider("claude")).rejects.toThrow();
    expect(rows("claude")).toEqual([]);
    failFetch = false;
    catalogs.set("claude", []);
    await cache.refreshProvider("claude");
    expect(rows("claude")).toEqual([]);
    catalogs.set("claude", [...CLAUDE_STATIC_MODELS]);
    await cache.refreshProvider("claude");
    expect(rows("claude")).toHaveLength(CLAUDE_STATIC_MODELS.length);
    expect(sightings.listOpen("claude")).toEqual([]);
    expect(await announcements()).toEqual([]);
  });

  it("acknowledges six new ids as a source change, but announces exactly five on the next refresh", async () => {
    startServices();
    await cache.refreshProvider("claude");
    const sourceChange = Array.from({ length: 6 }, (_, i) => ({ id: `source-${i}`, name: `Source ${i}` }));
    catalogs.set("claude", [...CLAUDE_STATIC_MODELS, ...sourceChange]);
    await cache.refreshProvider("claude");
    expect(await announcements()).toEqual([]);
    expect(rows("claude").filter((row) => row.modelId.startsWith("source-")).map((row) => row.acknowledgedAt === row.firstSeenAt))
      .toEqual([true, true, true, true, true, true]);
    const launches = Array.from({ length: 5 }, (_, i) => ({ id: `launch-${i}`, name: `Launch ${i}` }));
    catalogs.set("claude", [...sourceChange, ...launches]);
    await cache.refreshProvider("claude");
    expect(await announcements()).toEqual(launches.map(({ id, name }) => ({ modelId: id, label: name })));
  });

  it("notifies only after changed rows commit, deduplicates ids and scopes acknowledgements to one provider", async () => {
    const observed: string[][] = [];
    const unsubscribe = sightings.onChange((id) => observed.push(sightings.listOpen(id).map((row) => row.modelId)));
    await sightings.record("claude", [], BASELINE_AT);
    await sightings.record("claude", ["old", "old"], BASELINE_AT);
    await sightings.record("claude", ["new", "new"], LAUNCH_AT);
    await sightings.record("claude", ["new"], LAUNCH_AT);
    await sightings.record("cursor", ["old"], BASELINE_AT);
    await sightings.record("cursor", ["new"], LAUNCH_AT);
    await sightings.acknowledge("claude", LAUNCH_AT);
    await sightings.acknowledge("claude", LAUNCH_AT);
    expect(observed).toEqual([[], ["new"], [], ["new"], []]);
    expect(sightings.listOpen("claude")).toEqual([]);
    expect(sightings.listOpen("cursor").map((row) => row.modelId)).toEqual(["new"]);
    expect(rows("claude")).toHaveLength(2);
    unsubscribe();
    await sightings.record("claude", ["later"], LAUNCH_AT);
    expect(observed).toHaveLength(5);
  });

  it("republishes changed labels and hides removed models even when no sighting was inserted", async () => {
    startServices();
    await cache.refreshProvider("claude");
    catalogs.set("claude", [{ id: "new", name: "Initial label" }]);
    await cache.refreshProvider("claude");
    expect(await announcements()).toEqual([{ modelId: "new", label: "Initial label" }]);
    catalogs.set("claude", [{ id: "new", name: "Renamed" }]);
    await cache.refreshProvider("claude");
    expect(await announcements()).toEqual([{ modelId: "new", label: "Renamed" }]);
    catalogs.set("claude", []);
    await cache.refreshProvider("claude");
    expect(await announcements()).toEqual([]);
    expect(sightings.listOpen("claude").map((row) => row.modelId)).toEqual(["new"]);
  });

  it("keeps a successful refresh usable when recording fails, then retries on an unchanged refresh", async () => {
    startServices();
    await cache.refreshProvider("claude");
    owned.db.run("CREATE TRIGGER reject_sighting BEFORE INSERT ON provider_model_sightings BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const fresh = [...CLAUDE_STATIC_MODELS, { id: "new", name: "New" }];
    catalogs.set("claude", fresh);
    await expect(cache.refreshProvider("claude")).resolves.toEqual(fresh);
    expect(cache.getCached("claude")).toEqual(fresh);
    expect(await announcements()).toEqual([]);
    owned.db.run("DROP TRIGGER reject_sighting");
    await cache.refreshProvider("claude");
    expect(await announcements()).toEqual([{ modelId: "new", label: "New" }]);
  });
});
