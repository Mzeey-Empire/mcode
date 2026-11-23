import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, type PopoverRootChangeEventDetails } from "@/components/ui/popover";
import { sidePlacement } from "@/components/ui/side-placement";
import { SplitButton } from "@/components/ui/split-button";
import type { GitRowPlan, GitStep } from "@/features/thread-overview/git-next-step";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { cn } from "@/lib/utils";
import type { GitPushFailure, GitPushFailureKind } from "@mcode/contracts/models/git-push";
import { ArrowUp, ArrowUpFromLine, ChevronDown, GitBranchPlus, GitCommitHorizontal, GitPullRequest, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import {
  OVERVIEW_ROW_CLASS,
  OVERVIEW_SPLIT_CHEVRON_CLASS,
  OVERVIEW_SPLIT_MAIN_CLASS,
  OverviewRowIcon,
} from "@/features/thread-overview/overview-row";

const GIT_STEP_PRESENTATION: Record<GitStep, { label: string; icon: LucideIcon; testId: string }> = {
  "create-branch": { label: "Create branch…", icon: GitBranchPlus, testId: "thread-overview-create-branch" },
  commit: { label: "Commit…", icon: GitCommitHorizontal, testId: "workspace-menu-commit" },
  "commit-and-push": { label: "Commit and push…", icon: ArrowUpFromLine, testId: "workspace-menu-commit-and-push" },
  push: { label: "Push", icon: ArrowUp, testId: "workspace-menu-push" },
  "create-pr": { label: "Create PR…", icon: GitPullRequest, testId: "workspace-menu-create-pr" },
};

function samePlan(a: GitRowPlan | null, b: GitRowPlan | null): boolean {
  if (a === null || b === null) return a === b;
  return a.main === b.main && a.alternates.join() === b.alternates.join();
}

/**
 * Keeps the plan the row showed while it is held, so an agent's edits cannot swap the action
 * under a pointer, a keyboard focus, or an open menu. The live plan applies on release.
 */
function useHeldPlan(live: GitRowPlan | null, held: boolean): GitRowPlan | null {
  const [kept, setKept] = useState(live);
  if (!held && !samePlan(kept, live)) setKept(live);
  return held ? kept : live;
}

function useRowHold() {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperProps = {
    onPointerEnter: () => setPointerInside(true),
    onPointerLeave: () => setPointerInside(false),
    onFocus: () => setFocusInside(true),
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false);
    },
  };
  return { held: pointerInside || focusInside || menuOpen, wrapperProps, setMenuOpen };
}

function useRunGitStep(): (step: GitStep) => void {
  const { branchCreation, handleCommit, setCreatePrOpen, pushBranch } = useOverviewContext();
  return (step) => {
    if (step === "create-branch") branchCreation.setOpen(true);
    else if (step === "commit") handleCommit();
    else if (step === "commit-and-push") handleCommit({ push: true });
    else if (step === "push") void pushBranch();
    else setCreatePrOpen(true);
  };
}

function GitStepContent({ step }: { step: GitStep }) {
  const { label, icon: Icon } = GIT_STEP_PRESENTATION[step];
  return (<>
    <OverviewRowIcon><Icon /></OverviewRowIcon>
    <span className="font-medium">{label}</span>
  </>);
}

function GitSplitRow({ plan, run, onMenuOpenChange, loading }: {
  plan: GitRowPlan;
  loading: boolean;
  run: (step: GitStep) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  return (
    <SplitButton
      variant="ghost"
      className="w-full"
      menuLabel="More git actions"
      menuBeside="left"
      loading={loading}
      onClick={() => run(plan.main)}
      onMenuOpenChange={onMenuOpenChange}
      actionProps={{
        "data-testid": GIT_STEP_PRESENTATION[plan.main].testId,
        className: cn(OVERVIEW_ROW_CLASS, OVERVIEW_SPLIT_MAIN_CLASS, "min-w-0 flex-1 justify-start"),
      }}
      menuTriggerProps={{ className: OVERVIEW_SPLIT_CHEVRON_CLASS }}
      menu={plan.alternates.map((step) => {
        const { label, icon: Icon, testId } = GIT_STEP_PRESENTATION[step];
        return <DropdownMenuItem key={step} data-testid={testId} label={label} icon={<Icon />} onClick={() => run(step)} />;
      })}
    >
      <GitStepContent step={plan.main} />
    </SplitButton>
  );
}

const PUSH_FAILURE_REASON: Record<GitPushFailureKind, string | null> = {
  "hook-declined": "rejected by hook",
  "remote-ahead": "origin has newer commits",
  "timed-out": "timed out",
  other: null,
};

/**
 * A refused push as one status line under the row, built like the PR row's CI line, with git's own
 * lines in a popover beside the card. The row above keeps Push, so trying again stays one click.
 */
function GitPushFailureLine({ failure }: { failure: GitPushFailure["data"] }) {
  const [open, setOpen] = useState(false);
  const lineRef = useRef<HTMLDivElement | null>(null);
  const reason = PUSH_FAILURE_REASON[failure.kind];
  // The line's own button toggles the popover, so a press on it is not an outside press.
  const handleOpenChange = (nextOpen: boolean, details: PopoverRootChangeEventDetails) => {
    const target = details.event?.target;
    if (details.reason === "outside-press" && target instanceof Node && lineRef.current?.contains(target)) return;
    setOpen(nextOpen);
  };
  return (
    <div ref={lineRef} role="alert" data-testid="thread-overview-git-error">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((current) => !current)}
          className="flex h-7 w-full justify-between gap-3 border-transparent bg-transparent px-3 text-left text-muted hover:bg-hover/40 hover:text-ink dark:hover:bg-hover/40"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="size-5 shrink-0" />
            <span className="text-fade text-caption">
              <span className="text-status-label-error">Push failed</span>
              {reason ? ` · ${reason}` : null}
            </span>
          </span>
          <ChevronDown aria-hidden className={cn("-mr-0.5 shrink-0 text-muted transition-transform duration-150", open && "rotate-180")} />
        </Button>
        <PopoverContent
          {...sidePlacement(lineRef)}
          role="dialog"
          aria-label="Git output"
          data-testid="thread-overview-git-error-detail"
          className="w-[356px] p-0"
        >
          <div className="flex h-row-compact items-center justify-between gap-2 pl-3.5 pr-1.5 text-caption text-muted">
            <span>Git output</span>
            <CopyButton text={failure.detail} label="Copy git output" />
          </div>
          <pre className="mx-3.5 mb-3.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-hover/50 p-2 font-mono text-caption text-ink">
            {failure.detail}
          </pre>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function offersPush(plan: GitRowPlan | null): boolean {
  return plan !== null && (plan.main === "push" || plan.alternates.includes("push"));
}

function useSettlePush(gitRow: GitRowPlan | null) {
  const { gitPush, clearFinishedPush } = useOverviewContext();
  const finished = gitPush.kind === "landed" || gitPush.kind === "failed";
  const stale = finished && !offersPush(gitRow);
  useEffect(() => {
    if (stale) clearFinishedPush();
  }, [stale, clearFinishedPush]);
}

function GitEntry() {
  const { gitRow, gitPush } = useOverviewContext();
  const { held, wrapperProps, setMenuOpen } = useRowHold();
  const pushing = gitPush.kind === "pushing";
  useSettlePush(gitRow);
  // A push in flight holds the row so its Push cannot swap away. Once it lands, the pointer that
  // pushed no longer holds the row: the user's own action finished, so the next step shows at once.
  const plan = useHeldPlan(gitRow, pushing || (held && gitPush.kind !== "landed"));
  const run = useRunGitStep();
  if (!plan) return null;
  return (
    <div data-testid="thread-overview-git" {...wrapperProps}>
      {plan.alternates.length > 0 ? (
        <GitSplitRow plan={plan} run={run} onMenuOpenChange={setMenuOpen} loading={pushing} />
      ) : (
        <Button
          variant="ghost"
          size="compact"
          type="button"
          loading={pushing}
          data-testid={GIT_STEP_PRESENTATION[plan.main].testId}
          onClick={() => run(plan.main)}
          className={cn(OVERVIEW_ROW_CLASS, "justify-start text-ink")}
        >
          <GitStepContent step={plan.main} />
        </Button>
      )}
      {gitPush.kind === "failed" ? <GitPushFailureLine failure={gitPush.failure} /> : null}
    </div>
  );
}

/** The Overview's git row: the thread's next git step, with the other step that fits now in its menu. */
export function GitEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <GitEntry /> : null;
}
