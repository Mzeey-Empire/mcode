import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewUsage } from "@/features/thread-overview/use-overview-usage";
import { formatUsageResetText } from "@/lib/usage-reset-format";
import { cn } from "@/lib/utils";
import { isLowQuotaCategory } from "@/stores/provider-usage-snapshot";
import { type Thread } from "@/transport";
import { createTooltipHandle, Tooltip, TooltipContent, TooltipTrigger, type TooltipHandle } from "@/components/ui/tooltip";
import type { QuotaCategory } from "@mcode/contracts/providers/usage";
import { useState, type ReactNode } from "react";
import { ThreadOverviewWhen } from "@/features/thread-overview/overview-row";
import {
  usageCategoryPercent,
  usageCategoryShortLabel,
} from "@/features/thread-overview/use-overview-usage";

interface ThreadOverviewUsageProps {
  categories: QuotaCategory[];
  summary: string;
  sessionCost: string | null;
}

/**
 * One read-only Usage line: a muted name, then its value ending on the right edge. It has no icon, because
 * the section reads as one block of figures, and no hover, because nothing in it acts.
 */
function UsageLine({ name, children }: { name: ReactNode; children?: ReactNode }) {
  return (
    <div className="col-span-full grid h-row-compact grid-cols-subgrid items-center">
      <span className="text-fade text-muted">{name}</span>
      {children}
    </div>
  );
}

function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function UsageCategoryTooltipBody({ category }: { category: QuotaCategory }) {
  const resetText = formatUsageResetText(category.resetDate);
  return (
    <div className="flex flex-col items-start gap-0.5 tabular-nums">
      <span className="font-medium">
        {sentenceCase(usageCategoryShortLabel(category.label))}: {Math.round(usageCategoryPercent(category))}% used
      </span>
      {resetText ? <span className="text-muted">{resetText}</span> : null}
      {isLowQuotaCategory(category) ? (
        <span className="text-warning">Low quota: {Math.round(category.remainingPercent * 100)}% left</span>
      ) : null}
    </div>
  );
}

function UsageTooltipRoot({ handle }: { handle: TooltipHandle<QuotaCategory> }) {
  return (
    <Tooltip handle={handle}>
      {({ payload }) => (payload ? (
        <TooltipContent side="top" align="start">
          <UsageCategoryTooltipBody category={payload} />
        </TooltipContent>
      ) : null)}
    </Tooltip>
  );
}

function UsageCategory({ category, tooltip }: { category: QuotaCategory; tooltip: TooltipHandle<QuotaCategory> }) {
  const percent = usageCategoryPercent(category);
  const rounded = Math.round(percent);
  const isNearLimit = isLowQuotaCategory(category);
  const resetText = formatUsageResetText(category.resetDate);
  const shortLabel = usageCategoryShortLabel(category.label);
  const progressDescription = resetText
    ? `${shortLabel} usage ${rounded} percent. ${resetText}`
    : `${shortLabel} usage ${rounded} percent`;
  return (
    <TooltipTrigger handle={tooltip} payload={category} render={
      <div
        tabIndex={0}
        className="col-span-full grid h-row-compact grid-cols-subgrid items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
    }>
      <span className="text-fade text-muted">{sentenceCase(shortLabel)}</span>
      <div
        role="progressbar"
        aria-label={progressDescription}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        data-near-limit={isNearLimit || undefined}
        // Track and fill are picked for contrast in both themes: the track about 2.1:1 against the panel
        // so the 100% end reads, and each fill (ink, or warning near the limit) at least 3.2:1 against the track.
        className="h-1 w-full overflow-hidden rounded-[2px] bg-control-border/70"
      >
        <div
          className={cn("h-full rounded-[2px]", isNearLimit ? "bg-warning" : "bg-ink")}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span
        data-testid="thread-overview-usage-value"
        data-near-limit={isNearLimit || undefined}
        className={cn("text-right tabular-nums", isNearLimit ? "text-warning" : "text-ink")}
      >
        {rounded}%
      </span>
    </TooltipTrigger>
  );
}

function ThreadOverviewUsage({
  categories,
  summary,
  sessionCost,
}: ThreadOverviewUsageProps) {
  const [tooltip] = useState(() => createTooltipHandle<QuotaCategory>());
  return (
    // The lines share one set of columns: names sized to the longest, then each meter fills the
    // rest so every percent ends on the card's right edge, where the Changes totals end. Usage has
    // no glyphs, so it starts on the card title's edge like Recap below it.
    <section
      data-testid="thread-overview-usage"
      aria-label={`Usage, ${summary}`}
      className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_max-content] gap-x-3 px-3 text-body-small"
    >
      {categories.map((category) => (
        <UsageCategory key={category.label} category={category} tooltip={tooltip} />
      ))}
      <UsageTooltipRoot handle={tooltip} />
      {sessionCost ? (
        <UsageLine name="Session cost">
          <span className="col-span-2 text-right tabular-nums text-ink">{sessionCost}</span>
        </UsageLine>
      ) : null}
      {/* With nothing to measure, the summary is a status such as "Usage unavailable" and names itself. */}
      {categories.length === 0 && !sessionCost ? (
        <p className="col-span-full flex h-row-compact items-center text-fade text-muted">{summary}</p>
      ) : null}
    </section>
  );
}

function UsageEntry({ thread }: { thread: Thread }) {
  const { usageCategories, usageSummary, sessionCost } = useOverviewUsage(thread);
  return (<ThreadOverviewWhen when={usageSummary !== null}>
    <ThreadOverviewUsage
      categories={usageCategories}
      summary={usageSummary ?? ""}
      sessionCost={sessionCost}
    />
  </ThreadOverviewWhen>);
}

/** Usage block in the thread overview, preserving its existing row position. */
export function UsageEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <UsageEntry thread={subject.thread} /> : null;
}
