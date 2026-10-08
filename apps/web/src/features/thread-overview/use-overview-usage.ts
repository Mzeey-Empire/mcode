import { useThreadRecord } from "@/stores/thread-selectors";
import { type Thread } from "@/transport";
import type { ProviderUsageInfo, QuotaCategory } from "@mcode/contracts";
import { useMemo } from "react";

/** Shared usageCategoryShortLabel used by the overview entries. */
export function usageCategoryShortLabel(label: string): string {
  const normalized = label.trim();
  if (/^5[- ]hour/i.test(normalized)) return "5-hour";
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
  if (/^weekly/i.test(label)) return 1;
  return 2;
}

/** Shared usageCategoryFillClass used by the overview entries. */
export function usageCategoryFillClass(category: QuotaCategory): string {
  const percent = usageCategoryPercent(category);
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-primary";
  return "bg-[var(--diff-add-strong)]";
}

/** Shared usageCategoryMetricClass used by the overview entries. */
export function usageCategoryMetricClass(category: QuotaCategory): string {
  const percent = usageCategoryPercent(category);
  if (percent >= 90) return "text-destructive";
  if (percent >= 70) return "text-primary";
  return "text-ink/80";
}

/**
 * Returns the Overview session-cost label only for provider-proven API-key billing.
 */
export function formatThreadOverviewSessionCost(
  usageInfo: ProviderUsageInfo | undefined,
): string | null {
  if (usageInfo?.billingMode !== "api_key") return null;
  const sessionCostUsd = usageInfo.sessionCostUsd;
  if (typeof sessionCostUsd !== "number" || !Number.isFinite(sessionCostUsd)) return null;
  return `$${sessionCostUsd.toFixed(2)} session`;
}

/**
 * Returns capped quota categories in priority order for the Overview Usage panel.
 */
export function getThreadOverviewUsageCategories(
  usageInfo: ProviderUsageInfo | undefined,
  providerId = usageInfo?.providerId,
): QuotaCategory[] {
  if (providerId === "cursor") return [];
  return (
    usageInfo?.quotaCategories
      .filter((category) => !category.isUnlimited)
      .sort((a, b) => (
        usageCategoryPriority(a) - usageCategoryPriority(b)
        || usageCategoryPercent(b) - usageCategoryPercent(a)
      )) ?? []
  );
}

/**
 * Formats provider quota limits for compact Overview labels.
 */
export function formatThreadOverviewUsage(
  usageInfo: ProviderUsageInfo | undefined,
  providerId = usageInfo?.providerId,
): string | null {
  if (providerId === "cursor") return null;
  const categories = getThreadOverviewUsageCategories(usageInfo, providerId);
  const costSummary = formatThreadOverviewSessionCost(usageInfo);

  const quotaSummary = categories.length > 0
    ? categories
      .slice(0, 2)
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

/** Shared usage summary used by the usage row and the PR separator. */
export function useOverviewUsage(thread: Thread) {
  const usageInfo = useThreadRecord(
    thread.id,
    (record) => record.usageByProvider[thread.provider],
  );
  const usageCategories = useMemo(
    () => getThreadOverviewUsageCategories(usageInfo, thread.provider).slice(0, 2),
    [thread.provider, usageInfo],
  );
  const usageSummary = useMemo(
    () => formatThreadOverviewUsage(usageInfo, thread.provider),
    [thread.provider, usageInfo],
  );
  const sessionCostSummary = useMemo(
    () => formatThreadOverviewSessionCost(usageInfo),
    [usageInfo],
  );
  return { usageInfo, usageCategories, usageSummary, sessionCostSummary };
}
