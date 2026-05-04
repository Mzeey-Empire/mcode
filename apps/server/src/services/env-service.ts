/**
 * Builds complete environment objects for child spawns: current process env,
 * merged with a periodic fresh resolution from the user's shell or OS config,
 * with server-owned keys forced to the values captured at startup.
 */

import { injectable, inject } from "tsyringe";
import { ProtectedEnvStore } from "./protected-env-store.js";
import { flattenProcessEnv } from "./shell-env-utils.js";
import { ShellEnvResolver } from "./shell-env-resolver.js";

const DEFAULT_TTL_MS = 60_000;

/**
 * Public facade used by terminals and providers when spawning subprocesses.
 */
@injectable()
export class EnvService {
  private cached: Record<string, string> | null = null;
  private cacheExpiresAt = 0;

  constructor(
    @inject(ShellEnvResolver) private readonly shellEnvResolver: ShellEnvResolver,
    @inject(ProtectedEnvStore) private readonly protectedEnvStore: ProtectedEnvStore,
  ) {}

  /**
   * Returns env for `spawn` / PTY: live `process.env`, overlaid with cached
   * shell/registry resolution (refreshed at most every {@link DEFAULT_TTL_MS}),
   * then server-protected keys from startup.
   */
  getEnv(): Record<string, string> {
    const now = Date.now();
    if (this.cached && now < this.cacheExpiresAt) {
      return { ...this.cached };
    }

    const resolved = this.shellEnvResolver.resolveFresh();
    const base = flattenProcessEnv(process.env);
    const merged = this.protectedEnvStore.applyTo({ ...base, ...resolved });
    this.cached = merged;
    this.cacheExpiresAt = now + DEFAULT_TTL_MS;
    return { ...merged };
  }
}
