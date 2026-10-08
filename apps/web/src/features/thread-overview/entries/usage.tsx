import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { useOverviewUsage } from "@/features/thread-overview/use-overview-usage";
import { formatUsageResetText } from "@/lib/usage-reset-format";
import { cn } from "@/lib/utils";
import { useThreadStore } from "@/stores/threadStore";
import { type Thread } from "@/transport";
import type { ProviderUsageInfo, QuotaCategory } from "@mcode/contracts";
import { ChevronDown, Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { ThreadOverviewWhen } from "@/features/thread-overview/overview-row";
import {
  usageCategoryFillClass,
  usageCategoryMetricClass,
  usageCategoryPercent,
  usageCategoryShortLabel,
} from "@/features/thread-overview/use-overview-usage";

interface ThreadOverviewUsageBarsProps {
  categories: QuotaCategory[];
  summary: string;
  sessionCostSummary: string | null;
  usageStatus?: ProviderUsageInfo["usageStatus"];
}

const THREAD_OVERVIEW_USAGE_DETAILS_ID = "thread-overview-usage-details-panel";

/** Expandable quota usage row for the Thread Overview popover. */
function ThreadOverviewUsageBars({
  categories,
  summary,
  sessionCostSummary,
  usageStatus,
}: ThreadOverviewUsageBarsProps) {
  const [open, setOpen] = useState(true);

  if (categories.length === 0) {
    return (
      <div
        data-testid="thread-overview-usage"
        aria-label={`Usage, ${summary}`}
        className="flex h-8 w-full items-center justify-between gap-3 px-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Gauge aria-hidden className="size-3.5 shrink-0 text-muted" />
          <span className="text-fade text-xs font-medium">Usage</span>
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
          {summary}
        </span>
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="thread-overview-usage-section"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          data-testid="thread-overview-usage"
          aria-label={`Usage, ${summary}`}
          aria-controls={THREAD_OVERVIEW_USAGE_DETAILS_ID}
          className="h-8 w-full cursor-pointer justify-between gap-3 px-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Gauge aria-hidden className="size-3.5 shrink-0 text-muted" />
            <span className="text-fade text-xs font-medium">Usage</span>
          </span>
          <span className="flex min-w-0 shrink items-center gap-2">
            {!open ? (
              <span className="min-w-0 text-fade font-mono text-xs tabular-nums text-muted">
                {summary}
              </span>
            ) : null}
            <ChevronDown
              size={13}
              aria-hidden
              className={cn(
                "shrink-0 text-muted transition-transform duration-250 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </span>
        </Button>
      </CollapsibleTrigger>

      <AnimatedCollapsible open={open}>
        <div
          id={THREAD_OVERVIEW_USAGE_DETAILS_ID}
          data-testid="thread-overview-usage-details"
          aria-hidden={!open}
          className="flex gap-2 px-2 pb-2 pt-1 text-muted"
        >
          <span aria-hidden className="size-3.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-3">
            {categories.map((category) => {
              const percent = Math.min(Math.max(usageCategoryPercent(category), 0), 100);
              const rounded = Math.round(percent);
              const shortLabel = usageCategoryShortLabel(category.label);
              const displayLabel = category.label.trim();
              const resetText = formatUsageResetText(category.resetDate);
              const progressDescription = resetText
                ? `${shortLabel} usage ${rounded} percent. ${resetText}`
                : `${shortLabel} usage ${rounded} percent`;
              return (
                <div key={category.label} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 text-fade text-xs text-ink/80">{displayLabel}</span>
                    <span
                      data-testid="thread-overview-usage-value"
                      className={cn(
                        "shrink-0 font-mono text-xs font-medium tabular-nums",
                        usageCategoryMetricClass(category),
                      )}
                    >
                      {rounded}%
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={progressDescription}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={rounded}
                    className="h-1 w-full overflow-hidden rounded-full bg-hover"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none",
                        open && "animate-thread-overview-usage-fill",
                        usageCategoryFillClass(category),
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  {resetText ? (
                    <div className="font-mono text-xs tabular-nums text-muted">
                      {resetText}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {usageStatus === "stale" ? (
              <div className="font-mono text-xs uppercase tracking-wider text-muted/60">
                STALE
              </div>
            ) : null}
            {sessionCostSummary ? (
              <div className="flex items-baseline justify-between gap-3 pt-1">
                <span className="min-w-0 text-fade text-xs text-ink/80">Session cost</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                  {sessionCostSummary}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </AnimatedCollapsible>
    </Collapsible>
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
    <>
      <Separator className="my-1.5" />
      <ThreadOverviewUsageBars
        categories={usageCategories}
        summary={usageSummary ?? ""}
        sessionCostSummary={sessionCostSummary}
        usageStatus={usageInfo?.usageStatus}
      />
    </>
  </ThreadOverviewWhen>);
}

/** Usage block in the thread overview, preserving its existing row position. */
export function UsageEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <UsageEntry thread={subject.thread} /> : null;
}
