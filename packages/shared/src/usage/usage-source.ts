import type { QuotaCategory } from "@mcode/contracts";

/**
 * Source of provider usage data. Implementations look up plan utilization,
 * rate limits, or any quota signal exposed by a given provider.
 *
 * Returning `null` from `fetch()` means "temporarily unavailable" and
 * permits callers (e.g. CompositeUsageSource) to fall through to the
 * next source in a chain. Returning `[]` means "available, but this
 * account has no enforced quotas" and short-circuits the chain.
 */
export interface IUsageSource {
  /** Stable identifier used for logging and source-of-truth tracking. */
  readonly id: string;
  /** True when this source is currently usable (auth present, OS supported, etc). */
  isAvailable(): Promise<boolean>;
  /** Current quota state, or null if unavailable for transient reasons. */
  fetch(): Promise<QuotaCategory[] | null>;
}

/**
 * No-op usage source. Used by providers that do not yet expose any
 * usage signal, so the IUsageSource seam remains uniform.
 */
export class NullUsageSource implements IUsageSource {
  constructor(public readonly id: string) {}
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async fetch(): Promise<null> {
    return null;
  }
}
