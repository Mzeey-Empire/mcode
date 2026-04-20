import { inject, injectable } from "tsyringe";
import {
  PROVIDER_CATALOG,
  getCatalogEntry,
  type ProviderAvailability,
  type ProviderId,
  type IProviderRegistry,
} from "@mcode/contracts";
import { SettingsService } from "./settings-service.js";
import {
  ProviderDisabledError,
  ProviderCliMissingError,
} from "./provider-availability-errors.js";
import whichModule from "which";
import { promises as fsp, constants as fsConst } from "node:fs";

type CliRuntime = {
  status: "found" | "not_found" | "unchecked";
  resolvedPath: string | null;
};

/** Thin shim over `which` + fs so tests can inject stubs. */
export interface CliResolver {
  which(binary: string): Promise<string>;
  statExecutable(path: string): Promise<boolean>;
}

const defaultResolver: CliResolver = {
  which: (binary) => whichModule(binary),
  statExecutable: async (path) => {
    try {
      await fsp.access(path, fsConst.X_OK);
      return true;
    } catch {
      return false;
    }
  },
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
    private readonly resolver: CliResolver = defaultResolver,
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

  /**
   * Resolve and validate the CLI binary for the given provider.
   * When `settings.provider.cli[id]` is set, checks that exact path for execute
   * permissions; otherwise falls back to PATH lookup via `which`.
   * Caches the result for subsequent `listAvailability` calls.
   */
  async verifyCli(id: ProviderId): Promise<CliRuntime> {
    const s = this.settings.get();
    const configured =
      id === "codex" || id === "claude" || id === "copilot"
        ? s.provider.cli[id]
        : "";

    let result: CliRuntime;
    if (configured) {
      const ok = await this.resolver.statExecutable(configured);
      result = ok
        ? { status: "found", resolvedPath: configured }
        : { status: "not_found", resolvedPath: null };
    } else {
      try {
        const resolved = await this.resolver.which(getCatalogEntry(id).cliBinary);
        result = { status: "found", resolvedPath: resolved };
      } catch {
        result = { status: "not_found", resolvedPath: null };
      }
    }
    this.cliCache.set(id, result);
    return result;
  }

  /**
   * Throw a typed error if the provider is unusable. Returns normally otherwise.
   * CLI `unchecked` state is treated as "probably ok" — the first send will
   * re-verify and surface the real error if the binary is missing.
   */
  assertUsable(id: ProviderId): void {
    const s = this.settings.get();
    const entry = getCatalogEntry(id);
    if (entry.comingSoon || !s.provider.enabled[id]) {
      throw new ProviderDisabledError(id);
    }
    const cached = this.cliCache.get(id);
    if (cached?.status === "not_found") {
      const configuredPath =
        id === "codex" || id === "claude" || id === "copilot"
          ? s.provider.cli[id]
          : "";
      throw new ProviderCliMissingError(id, configuredPath);
    }
  }

  /** Run verification for every provider whose enabled flag is true and that has an adapter. */
  async verifyAllEnabled(): Promise<void> {
    const s = this.settings.get();
    const registered = new Set(this.registry.resolveAll().map((p) => p.id));
    const targets = PROVIDER_CATALOG.filter(
      (entry) => s.provider.enabled[entry.id] && registered.has(entry.id),
    );
    await Promise.all(targets.map((entry) => this.verifyCli(entry.id)));
  }

  private broadcastListeners: Array<(list: ProviderAvailability[]) => void> = [];
  private settingsSubscribed = false;

  /** Register a broadcast callback invoked whenever availability changes due to a settings update. */
  onChange(cb: (list: ProviderAvailability[]) => void): void {
    this.broadcastListeners.push(cb);
    // Subscribe to SettingsService once, no matter how many onChange callers there are.
    if (!this.settingsSubscribed) {
      this.settingsSubscribed = true;
      this.settings.on("change", (s) => {
        void this.handleSettingsChange(s);
      });
    }
  }

  private async handleSettingsChange(
    _next: ReturnType<SettingsService["get"]>,
  ): Promise<void> {
    await this.verifyAllEnabled();
    const list = this.listAvailability();
    for (const cb of this.broadcastListeners) cb(list);
  }
}
