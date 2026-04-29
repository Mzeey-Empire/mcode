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
  private inflight: Promise<QuotaCategory[] | null> | null = null;

  /** @param sources Ordered list of sources; earlier sources take priority. */
  constructor(private readonly sources: IUsageSource[]) {}

  /** True when at least one source in the chain reports available. */
  async isAvailable(): Promise<boolean> {
    for (const source of this.sources) {
      if (await source.isAvailable()) return true;
    }
    return false;
  }

  /**
   * Clears the result cache so the next `fetch()` call bypasses the TTL.
   * Call this immediately before emitting a QuotaUpdate event so the
   * warm-refresh path always reads fresh plan utilization.
   */
  invalidate(): void {
    this.cache = null;
  }

  /** Returns the first non-null result from the chain, cached for 90s. Concurrent calls share one in-flight request. */
  async fetch(): Promise<QuotaCategory[] | null> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.result;
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      for (const source of this.sources) {
        const result = await source.fetch();
        if (result !== null) {
          this.cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };
          return result;
        }
      }
      return null;
    })().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }
}
