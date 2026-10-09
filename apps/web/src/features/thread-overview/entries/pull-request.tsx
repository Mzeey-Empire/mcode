import { ChecksPopover } from "@/components/chat/ChecksPopover";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SplitButton } from "@/components/ui/split-button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { useOverviewUsage } from "@/features/thread-overview/use-overview-usage";
import { getBreakdown, getCiOverviewSummaryLabel, getCiSummaryHeadline } from "@/lib/ci-status";
import { registerCommand } from "@/lib/command-registry";
import { cn } from "@/lib/utils";
import { type Thread } from "@/transport";
import type { ChecksStatus } from "@mcode/contracts";
import { ChevronDown, GitPullRequest, Plus } from "lucide-react";
import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import {
  OVERVIEW_ROW_CLASS,
  ThreadOverviewTooltipButton,
  ThreadOverviewWhen,
} from "@/features/thread-overview/overview-row";

type CiSegmentName = "failing" | "running" | "passing" | "cancelled";

const CI_SEGMENT_COLORS: Record<CiSegmentName, string> = {
  failing: "var(--diff-remove-strong)",
  running: "var(--primary)",
  passing: "var(--diff-add-strong)",
  cancelled: "var(--muted)",
};

/** Shared ThreadOverviewPr used by the overview entries. */
export type ThreadOverviewPr = { number: number; url: string; state: string } | null;

type PrRowTone = "positive" | "danger" | "neutral" | "muted";

/** Returns the Overview status for an open pull request's CI checks. */
function getOpenPrRowStatus(checks: ChecksStatus | null): { label: string | null; tone: PrRowTone } {
  if (checks?.aggregate === "failing") return { label: getCiSummaryHeadline(checks), tone: "danger" };
  if (checks?.aggregate === "passing") return { label: getCiSummaryHeadline(checks), tone: "positive" };
  if (checks?.aggregate === "pending") return { label: getCiSummaryHeadline(checks), tone: "neutral" };
  return { label: null, tone: "positive" };
}

/** Returns the Overview status for a non-open pull request. */
function getClosedPrRowStatus(pr: NonNullable<ThreadOverviewPr>): { label: string; tone: PrRowTone } {
  if (pr.state.toLowerCase() === "merged") return { label: "Merged", tone: "positive" };
  if (pr.state.toLowerCase() === "closed") return { label: "Closed", tone: "danger" };
  return { label: pr.state, tone: "neutral" };
}

/** Returns the Overview status before the thread has a pull request. */
function getUnopenedPrRowStatus(hasCommitsAhead: boolean | null): { label: string; tone: PrRowTone } {
  if (hasCommitsAhead === true) return { label: "Ready", tone: "neutral" };
  if (hasCommitsAhead === false) return { label: "No commits ahead", tone: "muted" };
  return { label: "Checking", tone: "muted" };
}

function getPrRowStatus(
  pr: ThreadOverviewPr,
  hasCommitsAhead: boolean | null,
  checks: ChecksStatus | null,
): { label: string | null; tone: PrRowTone } {
  if (!pr) return getUnopenedPrRowStatus(hasCommitsAhead);
  if (pr.state.toLowerCase() === "open") return getOpenPrRowStatus(checks);
  return getClosedPrRowStatus(pr);
}

/**
 * Derives the PR row subtitle from PR state and branch readiness.
 */
export function getPrRowDetail(
  pr: ThreadOverviewPr,
  openPrDetail: { title?: string } | null,
): string | null {
  if (pr) return openPrDetail?.title?.trim() || null;
  return null;
}

/** Builds the segmented ring that summarizes CI run outcomes in the Overview. */
export function getCiStatusRingStyle(checks: ChecksStatus): CSSProperties {
  const breakdown = getBreakdown(checks);
  const total = breakdown.total || 1;
  const segments = ([
    { name: "failing", count: breakdown.failing },
    { name: "running", count: breakdown.running },
    { name: "passing", count: breakdown.passing },
    { name: "cancelled", count: breakdown.other },
  ] satisfies Array<{ name: CiSegmentName; count: number }>).filter((segment) => segment.count > 0);

  const ringMask = "radial-gradient(circle, transparent 42%, black 46%)";

  if (segments.length === 0) {
    return {
      background: "var(--hover)",
      maskImage: ringMask,
      WebkitMaskImage: ringMask,
    };
  }

  let cursor = 0;
  const stops = segments.map((segment) => {
    const start = cursor;
    cursor += (segment.count / total) * 100;
    const end = Math.min(100, cursor);
    return `${CI_SEGMENT_COLORS[segment.name]} ${start}% ${end}%`;
  });

  return {
    background: `conic-gradient(${stops.join(", ")})`,
    maskImage: ringMask,
    WebkitMaskImage: ringMask,
  };
}

function ThreadOverviewCiStatusCircle({ checks }: { checks: ChecksStatus }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <span
        aria-hidden
        data-testid="thread-overview-ci-status-circle"
        className="size-3.5 rounded-full"
        style={getCiStatusRingStyle(checks)}
      />
    </span>
  );
}

interface ThreadOverviewPrRowProps {
  pr: ThreadOverviewPr;
  hasCommitsAhead: boolean | null;
  checks: ChecksStatus | null;
  openPrDetail: { title?: string; author?: string } | null;
  threadId: string;
  onCommitOrPush: () => void;
  onCreatePr: () => void;
  onOpenPr: (url: string, event?: MouseEvent) => void;
}

function ThreadOverviewPrActionRow({
  hasCommitsAhead,
  onCommitOrPush,
  onCreatePr,
}: Pick<ThreadOverviewPrRowProps, "hasCommitsAhead" | "onCommitOrPush" | "onCreatePr">) {
  if (hasCommitsAhead === false) {
    return (
      <div data-testid="thread-overview-pr">
        <ThreadOverviewTooltipButton content="Ask the agent to commit and push the changes">
          <Button
            variant="ghost"
            size="compact"
            type="button"
            data-testid="workspace-menu-commit"
            className={cn(
              OVERVIEW_ROW_CLASS,
              "cursor-pointer justify-start text-xs text-ink/75 hover:bg-hover/40 hover:text-ink",
            )}
            onClick={onCommitOrPush}
          >
            <GitPullRequest size={14} className="shrink-0 text-muted" />
            <span className="font-medium">Commit or push</span>
          </Button>
        </ThreadOverviewTooltipButton>
      </div>
    );
  }

  return (
    <div data-testid="thread-overview-pr">
      <ThreadOverviewTooltipButton
        content={hasCommitsAhead ? "Create pull request" : "Waiting for commits ahead of base branch"}
        disabled={!hasCommitsAhead}
      >
        <Button
          variant="ghost"
          size="compact"
          type="button"
          data-testid="workspace-menu-create-pr"
          className={cn(
            OVERVIEW_ROW_CLASS,
            "cursor-pointer justify-start text-xs text-ink/75 hover:bg-hover/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50",
          )}
          onClick={onCreatePr}
          disabled={!hasCommitsAhead}
        >
          <GitPullRequest size={14} className="shrink-0 text-muted" />
          <span className="font-medium">Create PR</span>
        </Button>
      </ThreadOverviewTooltipButton>
    </div>
  );
}

function ThreadOverviewPrActiveRow({
  pr,
  hasCommitsAhead,
  checks,
  openPrDetail,
  threadId,
  onCreatePr,
  onOpenPr,
}: Required<Pick<ThreadOverviewPrRowProps, "pr" | "hasCommitsAhead" | "checks" | "openPrDetail" | "threadId" | "onCreatePr" | "onOpenPr">> & {
  pr: NonNullable<ThreadOverviewPrRowProps["pr"]>;
}) {
  const [checksOpen, setChecksOpen] = useState(false);
  const status = getPrRowStatus(pr, hasCommitsAhead, checks);
  const detailText = getPrRowDetail(pr, openPrDetail);
  const hasChecksData =
    pr.state.toLowerCase() === "open" &&
    checks != null &&
    checks.aggregate !== "no_checks";
  const canOpenChecks = hasChecksData && threadId.length > 0;

  useEffect(() => {
    if (!canOpenChecks) return;
    const dispose = registerCommand({
      id: "checks.open",
      title: "Open CI checks for active thread",
      category: "Git",
      handler: () => setChecksOpen(true),
    });
    return dispose;
  }, [canOpenChecks]);

  const rowLabel = detailText ?? `PR #${pr.number}`;
  const checksSummary =
    checks && canOpenChecks ? (
      <ChecksPopover
        checks={checks!}
        open={checksOpen}
        onOpenChange={setChecksOpen}
      >
        <ThreadOverviewTooltipButton content={getCiSummaryHeadline(checks)}>
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid="thread-overview-pr-status"
            aria-label={`CI checks, ${getCiSummaryHeadline(checks)}`}
            aria-expanded={checksOpen}
            aria-haspopup="dialog"
            onClick={(event) => {
              event.stopPropagation();
              setChecksOpen((open) => !open);
            }}
            className="flex h-7 w-full cursor-pointer justify-between gap-3 border-transparent bg-transparent px-2 text-left text-muted hover:bg-hover/40 hover:text-ink dark:hover:bg-hover/40"
          >
            <span className="flex min-w-0 items-center gap-2">
              <ThreadOverviewCiStatusCircle checks={checks} />
              <span className="text-fade font-mono text-xs tabular-nums">
                {getCiOverviewSummaryLabel(checks)}
              </span>
            </span>
            <ChevronDown
              size={12}
              aria-hidden
              className={cn(
                "shrink-0 text-muted transition-transform duration-150",
                checksOpen && "rotate-180",
              )}
            />
          </Button>
        </ThreadOverviewTooltipButton>
      </ChecksPopover>
    ) : (
      status.label ? (
        <span
          data-testid="thread-overview-pr-status"
          className="inline-flex h-7 w-full items-center gap-2 px-2 font-mono text-xs text-muted"
        >
          <span aria-hidden className="size-3.5 shrink-0" />
          <span className="text-fade">{status.label}</span>
        </span>
      ) : null
    );

  return (
    <div data-testid="thread-overview-pr" className="space-y-1">
      <SplitButton
        variant="ghost"
        className="w-full"
        menuLabel="More pull request actions"
        menuBeside="left"
        onClick={(event) => onOpenPr(pr.url, event)}
        actionProps={{
          "data-testid": "workspace-menu-open-pr",
          "aria-label": `Open pull request, ${rowLabel}`,
          className: "flex-1 justify-start px-2",
        }}
        menu={
          <DropdownMenuItem data-testid="workspace-menu-new-pr" label="Create new PR" icon={<Plus />} onClick={onCreatePr} />
        }
      >
        <GitPullRequest aria-hidden className="size-3.5 text-muted" />
        <span className={cn("text-fade text-xs", !detailText && "font-mono tabular-nums")}>{rowLabel}</span>
      </SplitButton>
      {checksSummary}
    </div>
  );
}

function ThreadOverviewPrRow({
  pr,
  hasCommitsAhead,
  checks,
  openPrDetail,
  threadId,
  onCommitOrPush,
  onCreatePr,
  onOpenPr,
}: ThreadOverviewPrRowProps) {
  if (!pr) {
    return (
      <ThreadOverviewPrActionRow
        hasCommitsAhead={hasCommitsAhead}
        onCommitOrPush={onCommitOrPush}
        onCreatePr={onCreatePr}
      />
    );
  }

  return (
    <ThreadOverviewPrActiveRow
      pr={pr}
      hasCommitsAhead={hasCommitsAhead}
      checks={checks}
      openPrDetail={openPrDetail}
      threadId={threadId}
      onCreatePr={onCreatePr}
      onOpenPr={onOpenPr}
    />
  );
}

function PullRequestEntry({ thread }: { thread: Thread }) {
  const { prable: canShowPrActions, effectivePr, hasCommitsAhead, checks, openPrDetail, handleCommitOrPush, handleOpenPr, setCreatePrOpen } = useOverviewContext();
  const { usageSummary } = useOverviewUsage(thread);

  return (<ThreadOverviewWhen when={canShowPrActions}>
    <>
      <ThreadOverviewWhen when={usageSummary !== null}>
        <Separator data-testid="thread-overview-pr-separator" className="my-1.5" />
      </ThreadOverviewWhen>
      <ThreadOverviewPrRow
        pr={effectivePr}
        hasCommitsAhead={hasCommitsAhead}
        checks={checks}
        openPrDetail={openPrDetail}
        threadId={thread.id}
        onCommitOrPush={handleCommitOrPush}
        onCreatePr={() => setCreatePrOpen(true)}
        onOpenPr={handleOpenPr}
      />
    </>
  </ThreadOverviewWhen>);
}

/** PullRequest block in the thread overview, preserving its existing row position. */
export function PullRequestEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <PullRequestEntry thread={subject.thread} /> : null;
}
