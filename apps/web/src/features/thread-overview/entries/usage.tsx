import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { useOverviewUsage } from "@/features/thread-overview/use-overview-usage";
import { formatUsageResetShort, formatUsageResetText } from "@/lib/usage-reset-format";
import { cn } from "@/lib/utils";
import { useThreadStore } from "@/stores/threadStore";
import { type Thread } from "@/transport";
import type { ProviderUsageInfo, QuotaCategory } from "@mcode/contracts/providers/usage";
import { useEffect } from "react";
import { ThreadOverviewWhen } from "@/features/thread-overview/overview-row";
import {
  usageCategoryPercent,
  usageCategoryShortLabel,
} from "@/features/thread-overview/use-overview-usage";

const USAGE_WARNING_PERCENT = 90;

interface ThreadOverviewUsageProps {
  categories: QuotaCategory[];
  summary: string;
  sessionCostSummary: string | null;
  usageStatus?: ProviderUsageInfo["usageStatus"];
}

function UsageCategory({ category }: { category: QuotaCategory }) {
  const percent = Math.min(Math.max(usageCategoryPercent(category), 0), 100);
  const rounded = Math.round(percent);
  const isNearLimit = percent >= USAGE_WARNING_PERCENT;
  const resetShort = formatUsageResetShort(category.resetDate);
  const resetText = formatUsageResetText(category.resetDate);
  const shortLabel = usageCategoryShortLabel(category.label);
  const progressDescription = resetText
    ? `${shortLabel} usage ${rounded} percent. ${resetText}`
    : `${shortLabel} usage ${rounded} percent`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
        <span className="text-fade min-w-0">{category.label.trim()}</span>
        <span
          data-testid="thread-overview-usage-value"
          className={cn("shrink-0 tabular-nums", isNearLimit && "text-primary")}
        >
          {resetShort ? `${rounded}% · ${resetShort}` : `${rounded}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={progressDescription}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        className="h-1 w-full overflow-hidden rounded-[2px] bg-hover"
      >
        <div
          className={cn("h-full rounded-[2px]", isNearLimit ? "bg-primary" : "bg-muted")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function ThreadOverviewUsage({
  categories,
  summary,
  sessionCostSummary,
  usageStatus,
}: ThreadOverviewUsageProps) {
  if (categories.length === 0) {
    return (
      <div
        data-testid="thread-overview-usage"
        aria-label={`Usage, ${summary}`}
        className="flex h-row-compact w-full items-center justify-between gap-3 px-3 text-body-small text-muted"
      >
        <span className="font-medium">Usage</span>
        <span className="shrink-0 tabular-nums">{summary}</span>
      </div>
    );
  }

  return (
    <section data-testid="thread-overview-usage" aria-label={`Usage, ${summary}`} className="px-3 pb-2">
      <div className="flex h-6 items-center text-xs font-medium text-muted">Usage</div>
      <div className="flex flex-col gap-3">
        {categories.map((category) => (
          <UsageCategory key={category.label} category={category} />
        ))}
        {usageStatus === "stale" ? (
          <div className="text-xs uppercase tracking-wider text-muted/60">STALE</div>
        ) : null}
        {sessionCostSummary ? (
          <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
            <span className="text-fade min-w-0">Session cost</span>
            <span className="shrink-0 tabular-nums">{sessionCostSummary}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function UsageEntry({ thread }: { thread: Thread }) {
  const { open } = useOverviewContext();
  const { usageInfo, usageCategories, usageSummary, sessionCostSummary } = useOverviewUsage(thread);
  const fetchProviderUsage = useThreadStore((state) => state.fetchProviderUsage);
  useEffect(() => {
    if (!open) return;
    void fetchProviderUsage(thread.id, thread.provider);
  }, [fetchProviderUsage, open, thread.id, thread.provider]);
  return (<ThreadOverviewWhen when={usageSummary !== null}>
    <ThreadOverviewUsage
      categories={usageCategories}
      summary={usageSummary ?? ""}
      sessionCostSummary={sessionCostSummary}
      usageStatus={usageInfo?.usageStatus}
    />
  </ThreadOverviewWhen>);
}

/** Usage block in the thread overview, preserving its existing row position. */
export function UsageEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <UsageEntry thread={subject.thread} /> : null;
}
