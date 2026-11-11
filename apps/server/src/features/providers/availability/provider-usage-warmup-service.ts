import { inject, injectable } from "tsyringe";
import type { IAgentProvider, IProviderRegistry } from "@mcode/contracts/providers/interfaces";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../settings/settings-service.js";

interface WarmableUsageProvider extends IAgentProvider {
  warmUsageCache?: (force?: boolean) => Promise<unknown>;
}

/**
 * Primes provider-owned usage caches for enabled providers before users open
 * usage UI on threads that have not sent a message yet.
 */
@injectable()
export class ProviderUsageWarmupService {
  constructor(
    @inject(SettingsService) private readonly settings: SettingsService,
    @inject("IProviderRegistry") private readonly registry: IProviderRegistry,
  ) {}

  /** Refreshes usage for each enabled provider that exposes it, concurrently. Resolves once every refresh settles. */
  async warmEnabledProviders(force = false): Promise<void> {
    const enabled = this.settings.get().provider.enabled;
    const warmups = this.registry.resolveAll()
      .filter((provider) => enabled[provider.id] && provider.getUsage)
      .map((provider) => this.warmProvider(provider as WarmableUsageProvider, force));
    await Promise.all(warmups);
  }

  private async warmProvider(provider: WarmableUsageProvider, force: boolean): Promise<void> {
    try {
      if (provider.warmUsageCache) {
        await provider.warmUsageCache(force);
        return;
      }
      await provider.getUsage?.();
    } catch (error) {
      logger.debug("Provider usage warm-up failed", {
        providerId: provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
