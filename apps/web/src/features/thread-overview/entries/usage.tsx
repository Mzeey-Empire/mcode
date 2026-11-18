import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { useOverviewUsage } from "@/features/thread-overview/use-overview-usage";
import { formatUsageResetText } from "@/lib/usage-reset-format";
import { cn } from "@/lib/utils";
import { useThreadStore } from "@/stores/threadStore";
import { type Thread } from "@/transport";
import type { ProviderUsageInfo, QuotaCategory } from "@mcode/contracts/providers/usage";
import { CircleDollarSign, Gauge } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { OverviewRowIcon, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";
import {
  usageCategoryPercent,
  usageCategoryShortLabel,
} from "@/features/thread-overview/use-overview-usage";

const USAGE_WARNING_PERCENT = 90;

interface ThreadOverviewUsageProps {
  categories: QuotaCategory[];
  summary: string;
  sessionCost: string | null;
  usageStatus?: ProviderUsageInfo["usageStatus"];
}

/**
 * One read-only Usage line in the row anatomy: icon lane, a muted name, then the value. It has no
 * hover, because nothing in it acts.
 */
function UsageLine({ icon, name, children }: { icon: ReactNode; name: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-row-compact items-center gap-2 px-3 text-body-small">
      <OverviewRowIcon>{icon}</OverviewRowIcon>
      <span className="min-w-0 flex-1 text-fade text-muted">{name}</span>
      {children}
    </div>
  );
}

function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * A limit on one line: its short name, a meter and the percent used. The reset time is left to the
 * meter's accessible name; at a glance only how close the limit is matters.
 */
function UsageCategory({ category, stale }: { category: QuotaCategory; stale: boolean }) {
  const percent = Math.min(Math.max(usageCategoryPercent(category), 0), 100);
  const rounded = Math.round(percent);
  const isNearLimit = percent >= USAGE_WARNING_PERCENT;
  const resetText = formatUsageResetText(category.resetDate);
  const shortLabel = usageCategoryShortLabel(category.label);
  const progressDescription = resetText
    ? `${shortLabel} usage ${rounded} percent. ${resetText}`
    : `${shortLabel} usage ${rounded} percent`;
  return (
    <UsageLine
      icon={<Gauge />}
      name={stale ? `${sentenceCase(shortLabel)} · stale` : sentenceCase(shortLabel)}
    >
      <div
        role="progressbar"
        aria-label={progressDescription}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        data-near-limit={isNearLimit || undefined}
        // Track and fill are picked for contrast in both themes: the track about 2.1:1 against the panel
        // so the 100% end reads, and each fill (ink, or warning near the limit) at least 3.2:1 against the track.
        className="h-1 w-16 shrink-0 overflow-hidden rounded-[2px] bg-control-border/70"
      >
        <div
          className={cn("h-full rounded-[2px]", isNearLimit ? "bg-warning" : "bg-ink")}
          style={{ width: `${percent}%` }}
        />
      </div>
      {/* A fixed width fits "100%", whose "%" is wider than a digit, so the meters of stacked limits line up. */}
      <span
        data-testid="thread-overview-usage-value"
        data-near-limit={isNearLimit || undefined}
        className={cn("w-[5ch] shrink-0 text-right tabular-nums", isNearLimit ? "text-warning" : "text-ink")}
      >
        {rounded}%
      </span>
    </UsageLine>
  );
}

function ThreadOverviewUsage({
  categories,
  summary,
  sessionCost,
  usageStatus,
}: ThreadOverviewUsageProps) {
  return (
    <section data-testid="thread-overview-usage" aria-label={`Usage, ${summary}`} className="flex flex-col">
      {categories.map((category) => (
        <UsageCategory key={category.label} category={category} stale={usageStatus === "stale"} />
      ))}
      {sessionCost ? (
        <UsageLine icon={<CircleDollarSign />} name="Session cost">
          <span className="shrink-0 tabular-nums text-ink">{sessionCost}</span>
        </UsageLine>
      ) : null}
      {/* With nothing to measure, the summary is a status such as "Usage unavailable" and names itself. */}
      {categories.length === 0 && !sessionCost ? <UsageLine icon={<Gauge />} name={summary} /> : null}
    </section>
  );
}

function UsageEntry({ thread }: { thread: Thread }) {
  const { open } = useOverviewContext();
  const { usageInfo, usageCategories, usageSummary, sessionCost } = useOverviewUsage(thread);
  const fetchProviderUsage = useThreadStore((state) => state.fetchProviderUsage);
  useEffect(() => {
    if (!open) return;
    void fetchProviderUsage(thread.id, thread.provider);
  }, [fetchProviderUsage, open, thread.id, thread.provider]);
  return (<ThreadOverviewWhen when={usageSummary !== null}>
    <ThreadOverviewUsage
      categories={usageCategories}
      summary={usageSummary ?? ""}
      sessionCost={sessionCost}
      usageStatus={usageInfo?.usageStatus}
    />
  </ThreadOverviewWhen>);
}

/** Usage block in the thread overview, preserving its existing row position. */
export function UsageEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <UsageEntry thread={subject.thread} /> : null;
}
