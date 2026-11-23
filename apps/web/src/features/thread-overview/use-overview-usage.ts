import { useThreadRecord } from "@/stores/thread-selectors";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import type { ProviderQuotaUsage, ThreadSessionUsage } from "@/stores/provider-usage-snapshot";
import { useProviderUsage } from "@/stores/providerUsageStore";
import { type Thread } from "@/transport";
import type { QuotaCategory } from "@mcode/contracts/providers/usage";
import { useMemo } from "react";

/** A weekly limit scoped to one model, such as Claude's "Weekly limit · Fable". */
const MODEL_WEEKLY_LIMIT = /^weekly limit · (.+)$/i;

/** Shared usageCategoryShortLabel used by the overview entries. */
export function usageCategoryShortLabel(label: string): string {
  const normalized = label.trim();
  if (/^5[- ]hour/i.test(normalized)) return "5-hour";
  const modelWeekly = MODEL_WEEKLY_LIMIT.exec(normalized);
  if (modelWeekly) return `weekly · ${modelWeekly[1]}`;
  if (/^weekly/i.test(normalized)) return "weekly";
  if (/^api/i.test(normalized)) return "API";
  if (/auto|composer/i.test(normalized)) return "Auto";
  return normalized;
}

/** Shared usageCategoryPercent used by the overview entries. */
export function usageCategoryPercent(category: QuotaCategory): number {
  if (typeof category.used === "number" && typeof category.total === "number" && category.total > 0) {
    return (category.used / category.total) * 100;
  }
  return (1 - category.remainingPercent) * 100;
}

function usageCategoryPriority(category: QuotaCategory): number {
  const label = category.label.trim();
  if (/^5[- ]hour/i.test(label)) return 0;
  if (MODEL_WEEKLY_LIMIT.test(label)) return 2;
  if (/^weekly/i.test(label)) return 1;
  return 3;
}

function modelWeeklyOrder(a: QuotaCategory, b: QuotaCategory): number {
  return usageCategoryPriority(a) === 2 ? a.label.localeCompare(b.label) : 0;
}

/**
 * Returns the session's cost as an amount, such as "$1.23", only for provider-proven API-key billing.
 */
export function formatThreadOverviewSessionCostAmount(
  usage: ProviderQuotaUsage | undefined,
  session: ThreadSessionUsage | undefined,
): string | null {
  if (usage?.billingMode !== "api_key") return null;
  const sessionCostUsd = session?.sessionCostUsd;
  if (typeof sessionCostUsd !== "number" || !Number.isFinite(sessionCostUsd)) return null;
  return `$${sessionCostUsd.toFixed(2)}`;
}

/**
 * Returns the Overview session-cost label only for provider-proven API-key billing.
 */
export function formatThreadOverviewSessionCost(
  usage: ProviderQuotaUsage | undefined,
  session: ThreadSessionUsage | undefined,
): string | null {
  const amount = formatThreadOverviewSessionCostAmount(usage, session);
  return amount ? `${amount} session` : null;
}

/**
 * Returns capped quota categories in priority order for the Overview Usage panel.
 */
export function getThreadOverviewUsageCategories(
  usageInfo: ProviderQuotaUsage | undefined,
  providerId = usageInfo?.providerId,
): QuotaCategory[] {
  if (providerId === "cursor") return [];
  return (
    usageInfo?.quotaCategories
      .filter((category) => !category.isUnlimited)
      .sort((a, b) => (
        usageCategoryPriority(a) - usageCategoryPriority(b)
        || modelWeeklyOrder(a, b)
        || usageCategoryPercent(b) - usageCategoryPercent(a)
      )) ?? []
  );
}

/**
 * Formats provider quota limits for compact Overview labels.
 */
export function formatThreadOverviewUsage(
  usageInfo: ProviderQuotaUsage | undefined,
  session: ThreadSessionUsage | undefined,
  providerId = usageInfo?.providerId,
): string | null {
  if (providerId === "cursor") return null;
  const categories = getThreadOverviewUsageCategories(usageInfo, providerId);
  const costSummary = formatThreadOverviewSessionCost(usageInfo, session);

  const quotaSummary = categories.length > 0
    ? categories
      .map((category) => {
        const percent = Math.round(usageCategoryPercent(category));
        return `${usageCategoryShortLabel(category.label)} ${percent}%`;
      })
      .join(", ")
    : null;

  const statusSummary = (() => {
    if (quotaSummary || costSummary) return null;
    if (usageInfo?.usageStatus === "ready-empty") return "No capped quota";
    if (usageInfo?.usageStatus === "unsupported") return "Usage not supported";
    if (usageInfo?.usageStatus === "unavailable") return "Usage unavailable";
    return null;
  })();

  return [quotaSummary, costSummary, statusSummary].filter(Boolean).join(", ") || null;
}

/**
 * Returns the thread's usage summary, quota bars, and session cost. The Overview watches the
 * provider's account quota only while it is open.
 */
export function useOverviewUsage(thread: Thread) {
  const { open } = useOverviewContext();
  const usageInfo = useProviderUsage(open ? thread.provider : undefined);
  const session = useThreadRecord(
    thread.id,
    (record) => record.sessionUsageByProvider[thread.provider],
  );
  const usageCategories = useMemo(
    () => getThreadOverviewUsageCategories(usageInfo, thread.provider),
    [thread.provider, usageInfo],
  );
  const usageSummary = useMemo(
    () => formatThreadOverviewUsage(usageInfo, session, thread.provider),
    [thread.provider, usageInfo, session],
  );
  const sessionCost = useMemo(
    () => formatThreadOverviewSessionCostAmount(usageInfo, session),
    [usageInfo, session],
  );
  return { usageInfo, usageCategories, usageSummary, sessionCost };
}
