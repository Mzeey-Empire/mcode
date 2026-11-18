import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { OVERVIEW_INLINE_ACTION_CLASS } from "@/features/thread-overview/overview-row";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { useOverviewMessages } from "@/features/thread-overview/use-overview-messages";
import { useThreadRecap } from "@/hooks/useThreadRecap";
import { cn } from "@/lib/utils";
import { type Thread } from "@/transport";
import { RefreshCw } from "lucide-react";

interface ThreadOverviewRecapRowProps {
  recapText: string | null;
  hasCoverageGap: boolean;
  coveredThrough: string | null;
  latestActivityAt: string | null;
  isGenerating: boolean;
  error: string | null;
  onRefresh: () => void;
}

function formatThreadRecapTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** Formats the recap coverage range when the recap trails recent activity. */
function getThreadRecapCoverageLabel({
  hasCoverageGap,
  coveredThrough,
  latestActivityAt,
}: Pick<ThreadOverviewRecapRowProps, "hasCoverageGap" | "coveredThrough" | "latestActivityAt">): {
  coveredThrough: string;
  latestActivityAt: string;
} | null {
  if (!hasCoverageGap || !coveredThrough || !latestActivityAt) return null;
  return {
    coveredThrough: formatThreadRecapTime(coveredThrough),
    latestActivityAt: formatThreadRecapTime(latestActivityAt),
  };
}

/** Shows recap coverage and refresh controls. */
function ThreadOverviewRecapControls({
  coverageLabel,
  isGenerating,
  onRefresh,
}: Pick<ThreadOverviewRecapRowProps, "isGenerating" | "onRefresh"> & {
  coverageLabel: ReturnType<typeof getThreadRecapCoverageLabel>;
}) {
  const refreshLabel = isGenerating ? "Refreshing recap" : "Refresh recap";

  return (
    <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">
      {/* "Out of date" already refreshes, so the icon would be a second control for the same action. */}
      {coverageLabel ? (
        <ThreadOverviewRecapCoverage
          coverageLabel={coverageLabel}
          isGenerating={isGenerating}
          onRefresh={onRefresh}
        />
      ) : <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-compact"
              type="button"
              data-testid="thread-overview-recap-refresh"
              aria-label={refreshLabel}
              disabled={isGenerating}
              onClick={onRefresh}
              className={cn("group -my-1 shrink-0", isGenerating && "text-muted/45")}
            >
              <RefreshCw
                aria-hidden
                className="transition-transform duration-200 ease-out group-active:rotate-45 motion-reduce:transition-none"
              />
            </Button>
          }
        />
        <TooltipContent>{refreshLabel}</TooltipContent>
      </Tooltip>}
    </div>
  );
}

/** Flags a recap that trails recent activity; clicking it refreshes the recap. */
function ThreadOverviewRecapCoverage({
  coverageLabel,
  isGenerating,
  onRefresh,
}: Pick<ThreadOverviewRecapRowProps, "isGenerating" | "onRefresh"> & {
  coverageLabel: NonNullable<ReturnType<typeof getThreadRecapCoverageLabel>>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="thread-overview-recap-coverage"
            aria-label={`Out of date, refresh recap. Covered through ${coverageLabel.coveredThrough}. Latest activity ${coverageLabel.latestActivityAt}`}
            disabled={isGenerating}
            onClick={onRefresh}
            className="shrink-0 rounded-sm px-1 text-caption text-muted hover:text-ink focus-visible:text-ink disabled:pointer-events-none"
          >
            Out of date
          </button>
        }
      />
      <TooltipContent side="bottom" align="end" className="flex-col items-start gap-0.5">
        <span>Covered through {coverageLabel.coveredThrough}</span>
        <span>Latest activity {coverageLabel.latestActivityAt}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadOverviewRecapRow({
  recapText,
  hasCoverageGap,
  coveredThrough,
  latestActivityAt,
  isGenerating,
  error,
  onRefresh,
}: ThreadOverviewRecapRowProps) {
  const refreshLabel = isGenerating ? "Refreshing recap" : "Refresh recap";
  const coverageLabel = getThreadRecapCoverageLabel({
    hasCoverageGap,
    coveredThrough,
    latestActivityAt,
  });

  return (
    <div
      data-testid="thread-overview-recap"
      className="w-full px-3 pb-2"
    >
      <div className="flex h-6 min-w-0 items-center justify-between gap-2">
        <span className="shrink-0 text-caption font-medium text-muted">Recap</span>
        <ThreadOverviewRecapControls
          coverageLabel={coverageLabel}
          isGenerating={isGenerating}
          onRefresh={onRefresh}
        />
      </div>
      {isGenerating ? (
        <div
          data-testid="thread-overview-recap-skeleton"
          role="status"
          aria-label={refreshLabel}
          className="mt-1 flex w-full flex-col gap-1.5"
        >
          <span className="sr-only">{refreshLabel}</span>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              aria-hidden
              className="h-2.5 rounded-full bg-hover/80 animate-[plan-fade_1.8s_ease-in-out_infinite]"
              style={{
                width: `${[88, 76, 48][i]}%`,
                animationDelay: `${i * 0.16}s`,
              }}
            />
          ))}
        </div>
      ) : !recapText && error ? (
        <p data-testid="thread-overview-recap-text" className="mt-1 text-caption text-muted">
          Couldn't generate recap{" "}
          <button
            type="button"
            data-testid="thread-overview-recap-retry"
            onClick={onRefresh}
            className={OVERVIEW_INLINE_ACTION_CLASS}
          >
            Retry
          </button>
        </p>
      ) : (
        <p
          data-testid="thread-overview-recap-text"
          className={cn(
            "mt-1 max-w-[26rem] whitespace-normal break-words text-caption leading-[1.45]",
            recapText ? "text-ink/85" : "text-muted",
          )}
        >
          {recapText ?? "No recap yet"}
        </p>
      )}
    </div>
  );
}

function useRecapState(thread: Thread) {
  const { open } = useOverviewContext();
  const sourceMessages = useOverviewMessages(thread.id, open);
  const recap = useThreadRecap({
    threadId: thread.id,
    messages: sourceMessages,
    overviewOpen: open,
  });
  return { ...recap, hasMessages: sourceMessages.length > 0 };
}

/** Preserves Recap request state and refs while the overview is closed. */
export const { Provider: RecapEntryState, useEntryState: useRecapEntryState } = createOverviewEntryState(useRecapState);

function RecapEntry() {
  const threadRecap = useRecapEntryState();
  // An empty thread has nothing to summarise, so an idle Recap block there is only noise.
  const hasRecapContent = threadRecap.hasMessages || threadRecap.recapText !== null
    || threadRecap.isGenerating || threadRecap.error !== null;
  if (!hasRecapContent) return null;
  return (<>
    <ThreadOverviewRecapRow
      recapText={threadRecap.recapText}
      hasCoverageGap={threadRecap.hasCoverageGap}
      coveredThrough={threadRecap.coveredThrough}
      latestActivityAt={threadRecap.latestActivityAt}
      isGenerating={threadRecap.isGenerating}
      error={threadRecap.error}
      onRefresh={() => void threadRecap.refresh()}
    /></>);
}

/** Recap block in the thread overview, preserving its existing row position. */
export function RecapEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <RecapEntry /> : null;
}
