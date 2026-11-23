import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger, type PopoverRootChangeEventDetails } from "@/components/ui/popover";
import { sidePlacement } from "@/components/ui/side-placement";
import { SplitButton } from "@/components/ui/split-button";
import type { GitRowPlan, GitStep } from "@/features/thread-overview/git-next-step";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { cn } from "@/lib/utils";
import type { GitPushFailure, GitPushFailureKind } from "@mcode/contracts/models/git-push";
import { ArrowUp, ArrowUpFromLine, GitBranchPlus, GitCommitHorizontal, GitPullRequest, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent, type ReactElement, type ReactNode, type RefObject } from "react";
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

function GitSplitRow({ plan, run, onMenuOpenChange, loading, actionRender, children }: {
  plan: GitRowPlan;
  loading: boolean;
  run: (step: GitStep) => void;
  onMenuOpenChange: (open: boolean) => void;
  /** Renders the main action as another element, such as the trigger of the failure card. */
  actionRender: ReactElement | undefined;
  /** Trailing content after the step's label. */
  children: ReactNode;
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
        render: actionRender,
      }}
      menuTriggerProps={{ className: OVERVIEW_SPLIT_CHEVRON_CLASS }}
      menu={plan.alternates.map((step) => {
        const { label, icon: Icon, testId } = GIT_STEP_PRESENTATION[step];
        return <DropdownMenuItem key={step} data-testid={testId} label={label} icon={<Icon />} onClick={() => run(step)} />;
      })}
    >
      <GitStepContent step={plan.main} />
      {children}
    </SplitButton>
  );
}

const PUSH_FAILURE_REASON: Record<GitPushFailureKind, string | null> = {
  "hook-declined": "rejected by hook",
  // A Review task pushes to the pull request's fork, so the remote is not always origin.
  "remote-ahead": "remote has newer commits",
  "timed-out": "timed out",
  other: null,
};

const FAILURE_CARD_HOVER_DELAY_MS = 300;

function pushFailureSummary(failure: GitPushFailure["data"]): string {
  const reason = PUSH_FAILURE_REASON[failure.kind];
  return reason ? `Push failed · ${reason}` : "Push failed";
}

/**
 * Opens git's output when the pointer rests on, or focus lands on, the row's main action. The
 * action's click still runs it, so trying again stays one click.
 */
function useFailureCard(failure: GitPushFailure["data"] | null) {
  const [open, setOpen] = useState(false);
  // Escape hands focus back to the trigger; that focus must not reopen the card.
  const escaped = useRef(false);
  const onOpenChange = (next: boolean, details: PopoverRootChangeEventDetails) => {
    escaped.current = details.reason === "escape-key";
    setOpen(next);
  };
  const trigger = failure ? (
    <PopoverTrigger
      openOnHover
      delay={FAILURE_CARD_HOVER_DELAY_MS}
      closeDelay={150}
      onFocus={() => {
        if (!escaped.current) setOpen(true);
        escaped.current = false;
      }}
      onBlur={() => {
        escaped.current = false;
      }}
    />
  ) : undefined;
  // A retry closes the card while its exit fade runs. The card keeps the last failure until then:
  // removing the content mid-fade leaves Base UI waiting on an animation that never ends, and the
  // next failure's card mounts stuck in that fade.
  const [shown, setShown] = useState(failure);
  if (failure !== null && failure !== shown) setShown(failure);
  return { open: failure !== null && open, onOpenChange, trigger, shown };
}

/** The quiet marker at the row's end; the card holds the reason and git's lines. */
function PushFailedHint({ step }: { step: GitStep }) {
  return (
    <span aria-hidden className="ml-auto shrink-0 text-caption text-status-label-error">
      {step === "push" ? "Failed" : "Push failed"}
    </span>
  );
}

function GitPushFailureCard({ failure, anchor }: { failure: GitPushFailure["data"]; anchor: RefObject<HTMLDivElement | null> }) {
  const reason = PUSH_FAILURE_REASON[failure.kind];
  return (
    <PopoverContent
      {...sidePlacement(anchor)}
      initialFocus={false}
      role="dialog"
      aria-label="Git output"
      data-testid="thread-overview-git-error-detail"
      className="w-[356px] p-0"
    >
      <div className="flex h-row-compact items-center justify-between gap-2 pl-3.5 pr-1.5 text-caption text-muted">
        <span className="text-fade min-w-0">
          <span className="text-status-label-error">Push failed</span>
          {reason ? ` · ${reason}` : null}
        </span>
        <CopyButton text={failure.detail} label="Copy git output" />
      </div>
      <pre className="mx-3.5 mb-3.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-hover/50 p-2 font-mono text-caption text-ink">
        {failure.detail}
      </pre>
    </PopoverContent>
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
  const rowRef = useRef<HTMLDivElement | null>(null);
  const failure = gitPush.kind === "failed" ? gitPush.failure : null;
  const failureCard = useFailureCard(failure);
  const pushing = gitPush.kind === "pushing";
  useSettlePush(gitRow);
  // A push in flight holds the row so its Push cannot swap away. Once it lands, the pointer that
  // pushed no longer holds the row: the user's own action finished, so the next step shows at once.
  const plan = useHeldPlan(gitRow, pushing || ((held || failureCard.open) && gitPush.kind !== "landed"));
  const run = useRunGitStep();
  if (!plan) return null;
  const hint = failure ? <PushFailedHint step={plan.main} /> : null;
  return (
    <div ref={rowRef} data-testid="thread-overview-git" {...wrapperProps}>
      <Popover open={failureCard.open} onOpenChange={failureCard.onOpenChange}>
        {plan.alternates.length > 0 ? (
          <GitSplitRow plan={plan} run={run} onMenuOpenChange={setMenuOpen} loading={pushing} actionRender={failureCard.trigger}>
            {hint}
          </GitSplitRow>
        ) : (
          <Button
            variant="ghost"
            size="compact"
            type="button"
            loading={pushing}
            render={failureCard.trigger}
            data-testid={GIT_STEP_PRESENTATION[plan.main].testId}
            onClick={() => run(plan.main)}
            className={cn(OVERVIEW_ROW_CLASS, "justify-start text-ink")}
          >
            <GitStepContent step={plan.main} />
            {hint}
          </Button>
        )}
        {failureCard.shown ? <GitPushFailureCard failure={failureCard.shown} anchor={rowRef} /> : null}
      </Popover>
      <span role="status" className="sr-only">{failure ? pushFailureSummary(failure) : ""}</span>
    </div>
  );
}

/** The Overview's git row: the thread's next git step, with the other step that fits now in its menu. */
export function GitEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <GitEntry /> : null;
}
