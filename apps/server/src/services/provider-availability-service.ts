import { inject, injectable } from "tsyringe";
import {
  PROVIDER_CATALOG,
  type ProviderAvailability,
  type ProviderId,
  type IProviderRegistry,
} from "@mcode/contracts";
import { SettingsService } from "./settings-service.js";

type CliRuntime = {
  status: "found" | "not_found" | "unchecked";
  resolvedPath: string | null;
};

/**
 * Tracks per-provider enabled flag + CLI verification state. Call sites use
 * `assertUsable` before resolving a provider from the registry.
 */
@injectable()
export class ProviderAvailabilityService {
  private cliCache = new Map<ProviderId, CliRuntime>();

  constructor(
    @inject(SettingsService) private readonly settings: SettingsService,
    @inject("IProviderRegistry") private readonly registry: IProviderRegistry,
  ) {}

  /** Build the full availability list from catalog + settings + cached CLI state. */
  listAvailability(): ProviderAvailability[] {
    const s = this.settings.get();
    const registered = new Set(this.registry.resolveAll().map((p) => p.id));

    return PROVIDER_CATALOG.map((entry): ProviderAvailability => {
      const cliRuntime: CliRuntime = this.cliCache.get(entry.id) ?? {
        status: "unchecked",
        resolvedPath: null,
      };
      const configuredPath =
        entry.id === "codex" || entry.id === "claude" || entry.id === "copilot"
          ? s.provider.cli[entry.id]
          : "";
      return {
        id: entry.id,
        enabled: s.provider.enabled[entry.id],
        hasAdapter: registered.has(entry.id),
        beta: entry.beta,
        comingSoon: entry.comingSoon,
        cli: {
          status: cliRuntime.status,
          resolvedPath: cliRuntime.resolvedPath,
          configuredPath,
        },
      };
    });
  }
}
