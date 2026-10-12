import { inject, injectable } from "tsyringe";
import { AgentEventType } from "@mcode/contracts";
import type {
  IAgentProvider,
  ProviderAuth,
  ProviderId,
  ProviderNewModel,
  ProviderStatus,
  ProviderStatusFacts,
  ProviderCliFacts,
  ProviderCliStatus,
  ProviderCliUpdate,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { isNewer } from "@mcode/providers";
import { broadcast } from "../../../application/transport/push.js";
import { SettingsService } from "../../settings/settings-service.js";
import { ProviderRateLimitStore } from "./provider-rate-limit-store.js";
import { NpmReleaseFeed } from "./npm-release-feed.js";
import { CliUpdateRunner, type CliUpdateRequest } from "./cli-update-runner.js";
import { ModelSightingsRepo } from "./model-sightings-repo.js";
import { ModelCacheService } from "../models/model-cache-service.js";
import type { ProviderEventIngressEvent } from "../composition/provider-event-ingress.js";

const LIST_CACHE_MS = 10 * 60 * 1000;
// Generous enough for a cold SDK start; a check past it would otherwise hold every caller of refresh().
const CHECK_TIMEOUT_MS = 30_000;
const UNKNOWN_AUTH: ProviderAuth = { state: "unknown" };

type StatusSource = Pick<IAgentProvider, "id" | "describeStatus" | "clearCliVersionCache">;
type ActiveCliUpdate = Extract<ProviderCliUpdate, { state: "running" | "failed" }>;

/** The registry surface the service reads; `IProviderRegistry` satisfies it. */
export interface StatusSourceRegistry {
  resolveAll(): readonly StatusSource[];
}

/**
 * Sign-in, rate-limit, CLI update and new-model state for each enabled provider, pushed to clients on
 * `providers.statusChanged` whenever a provider's state actually changes.
 */
@injectable()
export class ProviderStatusService {
  private readonly statuses = new Map<ProviderId, ProviderStatus>();
  private lastRefreshAtMs: number | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly cliFacts = new Map<ProviderId, ProviderCliFacts>();
  private readonly updates = new Map<ProviderId, ActiveCliUpdate>();
  private readonly updateRuns = new Map<ProviderId, Promise<ProviderStatus>>();
  private readonly checks = new Map<ProviderId, Promise<void>>();

  constructor(
    @inject(SettingsService) private readonly settings: Pick<SettingsService, "get" | "on">,
    @inject("IProviderRegistry") private readonly registry: StatusSourceRegistry,
    @inject(ProviderRateLimitStore) private readonly rateLimits: ProviderRateLimitStore,
    @inject(ModelSightingsRepo) private readonly sightings: ModelSightingsRepo,
    @inject(ModelCacheService) private readonly modelCache: ModelCacheService,
    @inject(NpmReleaseFeed) private readonly releases: Pick<NpmReleaseFeed, "latest"> = new NpmReleaseFeed(),
    @inject(CliUpdateRunner) private readonly runner: Pick<CliUpdateRunner, "canUpdate" | "update"> = new CliUpdateRunner(),
  ) {
    this.rateLimits.onChange((providerId) => this.applyState(providerId));
    this.sightings.onChange((providerId) => this.applyState(providerId));
    this.modelCache.onChange((providerId) => this.applyState(providerId));
    let checks = this.settings.get().updates.providerCliChecks;
    this.settings.on("change", (next) => {
      if (next.updates.providerCliChecks === checks) return;
      checks = next.updates.providerCliChecks;
      void this.refreshAfterSettingsChange();
    });
  }

  /** Acknowledges the provider's announcements and publishes the committed state through the repo listener. */
  acknowledgeModels(providerId: ProviderId): Promise<void> {
    return this.sightings.acknowledge(providerId, new Date().toISOString());
  }

  /** Returns the cached statuses, refreshing first when they are older than 10 minutes or `force` is set. */
  async listStatus(params: { force?: boolean } = {}): Promise<ProviderStatus[]> {
    const stale = this.lastRefreshAtMs === null || Date.now() - this.lastRefreshAtMs >= LIST_CACHE_MS;
    if (params.force || stale) await this.refresh();
    return [...this.statuses.values()];
  }

  /** Re-checks every enabled provider. Concurrent callers share one run. */
  refresh(): Promise<void> {
    this.inFlight ??= this.refreshEnabled().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Re-checks one enabled provider, sharing any check already running for it.
   * A disabled or unregistered provider is left alone.
   */
  recheck(providerId: ProviderId): Promise<void> {
    const provider = this.enabledProviders().find((source) => source.id === providerId);
    return provider ? this.refreshProvider(provider) : Promise.resolve();
  }

  private async refreshEnabled(): Promise<void> {
    const providers = this.enabledProviders();
    const enabledIds = new Set(providers.map((provider) => provider.id));
    for (const providerId of this.statuses.keys()) {
      if (!enabledIds.has(providerId)) this.statuses.delete(providerId);
    }
    await Promise.all(providers.map((provider) => this.refreshProvider(provider)));
    this.lastRefreshAtMs = Date.now();
  }

  private async refreshAfterSettingsChange(): Promise<void> {
    await this.inFlight;
    await this.refresh();
  }

  private refreshProvider(provider: StatusSource): Promise<void> {
    const existing = this.checks.get(provider.id);
    if (existing) return existing;
    const check = this.checkProvider(provider).finally(() => this.checks.delete(provider.id));
    this.checks.set(provider.id, check);
    return check;
  }

  private async checkProvider(provider: StatusSource): Promise<void> {
    const facts = await this.describeFacts(provider);
    if (facts.cli) this.cliFacts.set(provider.id, facts.cli);
    else this.cliFacts.delete(provider.id);
    const cli = await this.describeCli(provider.id, facts.cli);
    this.publish({
      providerId: provider.id,
      auth: facts.auth,
      cli: this.settings.get().updates.providerCliChecks ? cli : withoutUpdate(cli),
      rateLimit: this.rateLimits.get(provider.id),
      newModels: this.newModels(provider.id),
      checkedAt: new Date().toISOString(),
    });
  }

  private async describeFacts(provider: StatusSource): Promise<ProviderStatusFacts> {
    if (!provider.describeStatus) return { auth: UNKNOWN_AUTH };
    try {
      return await withTimeout(provider.describeStatus(), CHECK_TIMEOUT_MS);
    } catch (error) {
      // Only the error name is logged: provider messages can quote CLI output holding an account email.
      logger.warn("Provider status check failed", {
        providerId: provider.id,
        error: error instanceof Error ? error.name : typeof error,
      });
      return { auth: this.statuses.get(provider.id)?.auth ?? UNKNOWN_AUTH, cli: this.cliFacts.get(provider.id) };
    }
  }

  private async describeCli(providerId: ProviderId, facts?: ProviderCliFacts): Promise<ProviderCliStatus | null> {
    if (!facts) return null;
    const cli: ProviderCliStatus = { installed: facts.installed, managedBy: facts.managedBy, latest: null, update: { state: "none" } };
    if (facts.managedBy === "mcode" || !this.settings.get().updates.providerCliChecks || !facts.npmPackage) return cli;
    cli.latest = await this.releases.latest(facts.npmPackage);
    cli.update = await this.describeUpdate(providerId, facts, cli.latest);
    return cli;
  }

  private async describeUpdate(providerId: ProviderId, facts: ProviderCliFacts, latest: string | null): Promise<ProviderCliUpdate> {
    const previous = this.updates.get(providerId);
    if (previous?.state === "running") return previous;
    if (!latest || !facts.installed || !isNewer(latest, facts.installed)) {
      return { state: "none" };
    }
    if (!facts.resolvedPath || !await this.runner.canUpdate(facts.resolvedPath)) return { state: "none" };
    if (previous?.target === latest) return previous;
    return { state: "available", target: latest };
  }

  /** Concurrent requests for a provider share one install and receive its final status. */
  updateCli(providerId: ProviderId): Promise<ProviderStatus> {
    const existing = this.updateRuns.get(providerId);
    if (existing) return existing;
    const run = this.runUpdate(providerId).finally(() => this.updateRuns.delete(providerId));
    this.updateRuns.set(providerId, run);
    return run;
  }

  private async runUpdate(providerId: ProviderId): Promise<ProviderStatus> {
    await this.inFlight;
    const provider = this.enabledProviders().find((source) => source.id === providerId);
    if (!provider) throw new Error("Provider is not enabled.");
    await this.refreshProvider(provider);
    const status = this.statuses.get(providerId);
    if (!status) throw new Error("Provider status is unavailable.");
    const request = this.updateRequest(status);
    this.setUpdate(providerId, { state: "running", target: request.target });
    try {
      const result = await this.runner.update(request);
      await this.checks.get(providerId);
      if (!result.ok) this.setUpdate(providerId, { state: "failed", target: request.target, reason: result.reason.slice(0, 240) });
      else {
        this.updates.delete(providerId);
        provider.clearCliVersionCache?.();
        await this.refreshProvider(provider);
      }
    } catch (error) {
      await this.checks.get(providerId);
      this.setUpdate(providerId, { state: "failed", target: request.target, reason: (error instanceof Error ? error.name : "CLI update failed.").slice(0, 240) });
    }
    return this.statuses.get(providerId) ?? status;
  }

  private updateRequest(status: ProviderStatus): CliUpdateRequest {
    const facts = this.cliFacts.get(status.providerId);
    const update = status.cli?.update;
    if (!facts?.resolvedPath || !facts.npmPackage || !update || (update.state !== "available" && update.state !== "failed")) {
      throw new Error("Provider CLI has no available npm update.");
    }
    return { resolvedPath: facts.resolvedPath, npmPackage: facts.npmPackage, target: update.target };
  }

  private setUpdate(providerId: ProviderId, update: ActiveCliUpdate): void {
    this.updates.set(providerId, update);
    const status = this.statuses.get(providerId);
    if (status?.cli && this.settings.get().updates.providerCliChecks) {
      this.publish({ ...status, cli: { ...status.cli, update } });
    }
  }

  private applyState(providerId: ProviderId): void {
    if (!this.settings.get().provider.enabled[providerId]) return;
    const previous = this.statuses.get(providerId);
    this.publish({
      providerId,
      auth: previous?.auth ?? UNKNOWN_AUTH,
      cli: previous?.cli ?? null,
      rateLimit: this.rateLimits.get(providerId),
      newModels: this.newModels(providerId),
      checkedAt: previous?.checkedAt ?? new Date().toISOString(),
    });
  }

  private newModels(providerId: ProviderId): ProviderNewModel[] {
    if (providerId === "opencode") return [];
    const models = new Map(this.modelCache.getCached(providerId)?.map((model) => [model.id, model]));
    return this.sightings.listOpen(providerId)
      .filter((sighting) => models.has(sighting.modelId))
      .slice(0, 5)
      .map(({ modelId }) => ({ modelId, label: models.get(modelId)?.name || modelId }));
  }

  private publish(next: ProviderStatus): void {
    const previous = this.statuses.get(next.providerId);
    this.statuses.set(next.providerId, next);
    if (previous && sameState(previous, next)) return;
    broadcast("providers.statusChanged", next);
  }

  private enabledProviders(): StatusSource[] {
    const enabled = this.settings.get().provider.enabled;
    return this.registry.resolveAll().filter((provider) => enabled[provider.id]);
  }
}

/**
 * Builds a provider-event-ingress observer that re-checks a provider's sign-in after one of its turns
 * fails with an auth error, so the bell and the turn's end notice see the signed-out state.
 */
export function recheckAfterAuthFailure(
  service: Pick<ProviderStatusService, "recheck">,
): (delivered: ProviderEventIngressEvent) => void {
  return (delivered) => {
    if (delivered.event.type !== AgentEventType.Error || delivered.event.failure.kind !== "auth") return;
    // The observer runs inside ingress delivery, so a failed check is logged here rather than left unhandled.
    service.recheck(delivered.providerId).catch((error: unknown) => {
      logger.warn("Provider re-check after an auth failure failed", {
        providerId: delivered.providerId,
        error: error instanceof Error ? error.name : typeof error,
      });
    });
  };
}

class StatusCheckTimeoutError extends Error {
  override name = "StatusCheckTimeoutError";
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StatusCheckTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// `checkedAt` moves on every refresh, so it is left out or every refresh would push.
function sameState(a: ProviderStatus, b: ProviderStatus): boolean {
  return JSON.stringify([a.auth, a.rateLimit, a.cli, a.newModels]) === JSON.stringify([b.auth, b.rateLimit, b.cli, b.newModels]);
}

function withoutUpdate(cli: ProviderCliStatus | null): ProviderCliStatus | null {
  return cli && { ...cli, latest: null, update: { state: "none" } };
}
