import { inject, injectable } from "tsyringe";
import type {
  IAgentProvider,
  ProviderAuth,
  ProviderId,
  ProviderStatus,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { broadcast } from "../../../application/transport/push.js";
import { SettingsService } from "../../settings/settings-service.js";
import { ProviderRateLimitStore } from "./provider-rate-limit-store.js";

const LIST_CACHE_MS = 10 * 60 * 1000;
const UNKNOWN_AUTH: ProviderAuth = { state: "unknown" };

type StatusSource = Pick<IAgentProvider, "id" | "describeStatus">;

/** The registry surface the service reads; `IProviderRegistry` satisfies it. */
export interface StatusSourceRegistry {
  resolveAll(): readonly StatusSource[];
}

/**
 * Sign-in and rate-limit state for each enabled provider, pushed to clients on
 * `providers.statusChanged` whenever a provider's state actually changes.
 */
@injectable()
export class ProviderStatusService {
  private readonly statuses = new Map<ProviderId, ProviderStatus>();
  private lastRefreshAtMs: number | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    @inject(SettingsService) private readonly settings: Pick<SettingsService, "get">,
    @inject("IProviderRegistry") private readonly registry: StatusSourceRegistry,
    @inject(ProviderRateLimitStore) private readonly rateLimits: ProviderRateLimitStore,
  ) {
    this.rateLimits.onChange((providerId) => this.applyRateLimit(providerId));
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

  private async refreshEnabled(): Promise<void> {
    const providers = this.enabledProviders();
    const enabledIds = new Set(providers.map((provider) => provider.id));
    for (const providerId of this.statuses.keys()) {
      if (!enabledIds.has(providerId)) this.statuses.delete(providerId);
    }
    await Promise.all(providers.map(async (provider) => {
      const auth = await this.describeAuth(provider);
      this.publish({
        providerId: provider.id,
        auth,
        rateLimit: this.rateLimits.get(provider.id),
        checkedAt: new Date().toISOString(),
      });
    }));
    this.lastRefreshAtMs = Date.now();
  }

  private async describeAuth(provider: StatusSource): Promise<ProviderAuth> {
    if (!provider.describeStatus) return UNKNOWN_AUTH;
    try {
      return (await provider.describeStatus()).auth;
    } catch (error) {
      // Only the error name is logged: provider messages can quote CLI output holding an account email.
      logger.warn("Provider status check failed", {
        providerId: provider.id,
        error: error instanceof Error ? error.name : typeof error,
      });
      return this.statuses.get(provider.id)?.auth ?? UNKNOWN_AUTH;
    }
  }

  private applyRateLimit(providerId: ProviderId): void {
    if (!this.settings.get().provider.enabled[providerId]) return;
    const previous = this.statuses.get(providerId);
    this.publish({
      providerId,
      auth: previous?.auth ?? UNKNOWN_AUTH,
      rateLimit: this.rateLimits.get(providerId),
      checkedAt: previous?.checkedAt ?? new Date().toISOString(),
    });
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

// `checkedAt` moves on every refresh, so it is left out or every refresh would push.
function sameState(a: ProviderStatus, b: ProviderStatus): boolean {
  return JSON.stringify([a.auth, a.rateLimit]) === JSON.stringify([b.auth, b.rateLimit]);
}
