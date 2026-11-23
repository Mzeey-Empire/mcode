import type { ProviderUsageInfo, QuotaCategory } from "@mcode/contracts/providers/usage";

const USAGE_STALE_TTL_MS = 24 * 60 * 60 * 1000;

type SessionField = "sessionCostUsd" | "serviceTier" | "numTurns" | "durationMs";

/** Account-wide usage for one provider. Per-thread metrics belong in `ThreadSessionUsage`. */
export type ProviderQuotaUsage = Omit<ProviderUsageInfo, SessionField>;

/** One thread's own session metrics for one provider, taken only from that thread's quotaUpdate events. */
export type ThreadSessionUsage = Pick<ProviderUsageInfo, SessionField>;

/** A thread's session metrics keyed by provider id. */
export type ThreadSessionUsageByProvider = Readonly<Partial<Record<string, ThreadSessionUsage>>>;

/**
 * Copies the account-wide fields into a new object. A return type annotation alone would leave the
 * provider-wide session cost on the runtime object.
 */
export function toProviderQuotaUsage(usage: ProviderUsageInfo): ProviderQuotaUsage {
  return {
    providerId: usage.providerId,
    quotaCategories: usage.quotaCategories,
    billingMode: usage.billingMode,
    usageStatus: usage.usageStatus,
    fetchedAt: usage.fetchedAt,
    failedAt: usage.failedAt,
    diagnostic: usage.diagnostic,
  };
}

/** Creates an `unavailable` snapshot that failed at `now`. */
export function failedUsage(providerId: string, now: number): ProviderQuotaUsage {
  return {
    providerId,
    quotaCategories: [],
    usageStatus: "unavailable",
    failedAt: new Date(now).toISOString(),
    diagnostic: "Usage refresh failed",
  };
}

/** Returns whether a capped quota window has less than a fifth left. */
export function isLowQuotaCategory(category: QuotaCategory): boolean {
  return !category.isUnlimited && category.remainingPercent < 0.2;
}

function hasQuota(usage: ProviderQuotaUsage | undefined): usage is ProviderQuotaUsage {
  return (usage?.quotaCategories.length ?? 0) > 0;
}

function isFreshUsageSnapshot(usage: ProviderQuotaUsage, now: number): boolean {
  if (!usage.fetchedAt) return true;
  const fetchedAt = Date.parse(usage.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt <= USAGE_STALE_TTL_MS;
}

function resolveUsageStatus(incoming: ProviderQuotaUsage): NonNullable<ProviderQuotaUsage["usageStatus"]> {
  return incoming.usageStatus ?? (incoming.quotaCategories.length === 0 ? "unavailable" : "ready");
}

function unavailableSnapshot(
  existing: ProviderQuotaUsage | undefined,
  incoming: ProviderQuotaUsage,
  status: "unavailable" | "unsupported",
  now: number,
): ProviderQuotaUsage {
  if (hasQuota(existing) && isFreshUsageSnapshot(existing, now)) {
    return {
      ...existing,
      usageStatus: "stale",
      failedAt: incoming.failedAt ?? new Date(now).toISOString(),
      diagnostic: incoming.diagnostic,
    };
  }
  return { ...incoming, billingMode: incoming.billingMode ?? existing?.billingMode, usageStatus: status };
}

function emptySnapshot(incoming: ProviderQuotaUsage, now: number): ProviderQuotaUsage {
  return {
    providerId: incoming.providerId,
    quotaCategories: [],
    billingMode: incoming.billingMode,
    usageStatus: "ready-empty",
    fetchedAt: incoming.fetchedAt ?? new Date(now).toISOString(),
  };
}

function readySnapshot(
  existing: ProviderQuotaUsage | undefined,
  incoming: ProviderQuotaUsage,
  now: number,
): ProviderQuotaUsage {
  const hasQuotaCategories = incoming.quotaCategories.length > 0;
  return {
    ...existing,
    ...incoming,
    quotaCategories: hasQuotaCategories ? incoming.quotaCategories : (existing?.quotaCategories ?? []),
    usageStatus: hasQuotaCategories ? "ready" : (incoming.usageStatus ?? "ready-empty"),
    fetchedAt: incoming.fetchedAt ?? new Date(now).toISOString(),
    failedAt: undefined,
    diagnostic: undefined,
  };
}

/**
 * Merges an observation into the last snapshot. An `unavailable` or `unsupported` observation keeps
 * existing quota as `stale` if it was fetched within 24 hours or has no fetch time. A successful
 * observation clears the failure details, and `ready-empty` also clears the quota.
 */
export function mergeProviderUsageSnapshot(
  existing: ProviderQuotaUsage | undefined,
  incoming: ProviderQuotaUsage,
  now = Date.now(),
): ProviderQuotaUsage {
  const status = resolveUsageStatus(incoming);
  if (status === "unavailable" || status === "unsupported") {
    return unavailableSnapshot(existing, incoming, status, now);
  }
  if (status === "ready-empty") return emptySnapshot(incoming, now);
  return readySnapshot(existing, incoming, now);
}

function definedSessionFields(event: Partial<ThreadSessionUsage>): Partial<ThreadSessionUsage> {
  const fields: Partial<ThreadSessionUsage> = {};
  if (event.sessionCostUsd !== undefined) fields.sessionCostUsd = event.sessionCostUsd;
  if (event.serviceTier !== undefined) fields.serviceTier = event.serviceTier;
  if (event.numTurns !== undefined) fields.numTurns = event.numTurns;
  if (event.durationMs !== undefined) fields.durationMs = event.durationMs;
  return fields;
}

/**
 * Applies the defined session fields of one event over the thread's previous metrics for that provider.
 * Returns `previous` itself when the event carries none, so the thread record stays unchanged.
 */
export function mergeSessionUsage(
  previous: ThreadSessionUsageByProvider,
  event: { providerId: string } & Partial<ThreadSessionUsage>,
): ThreadSessionUsageByProvider {
  const fields = definedSessionFields(event);
  if (Object.keys(fields).length === 0) return previous;
  return { ...previous, [event.providerId]: { ...previous[event.providerId], ...fields } };
}
