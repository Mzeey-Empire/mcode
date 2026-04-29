import type { QuotaCategory } from "@mcode/contracts";
import type { IUsageSource } from "@mcode/shared/usage";

const CACHE_TTL_MS = 90_000;

interface CacheEntry {
  result: QuotaCategory[];
  expiresAt: number;
}

/**
 * Walks an ordered list of usage sources and returns the first non-null
 * result. Successful results are cached for 90 seconds; null results
 * are not cached so transient failures recover quickly on the next call.
 */
export class CompositeUsageSource implements IUsageSource {
  readonly id = "claude.composite";
  private cache: CacheEntry | null = null;

  /** @param sources Ordered list of sources; earlier sources take priority. */
  constructor(private readonly sources: IUsageSource[]) {}

  /** True when at least one source in the chain reports available. */
  async isAvailable(): Promise<boolean> {
    for (const source of this.sources) {
      if (await source.isAvailable()) return true;
    }
    return false;
  }

  /** Returns the first non-null result from the chain, cached for 90s. */
  async fetch(): Promise<QuotaCategory[] | null> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.result;
    }

    for (const source of this.sources) {
      const result = await source.fetch();
      if (result !== null) {
        this.cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };
        return result;
      }
    }
    return null;
  }
}
