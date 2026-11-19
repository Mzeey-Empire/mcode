import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SplitButton } from "@/components/ui/split-button";
import type { GitRowPlan, GitStep } from "@/features/thread-overview/git-next-step";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { cn } from "@/lib/utils";
import { ArrowUpFromLine, GitBranchPlus, GitCommitHorizontal, GitPullRequest, type LucideIcon } from "lucide-react";
import { useState, type FocusEvent } from "react";
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

/** Tracks whether the pointer, focus, or the row's menu is on the git row. */
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
  const { branchCreation, handleCommit, setCreatePrOpen } = useOverviewContext();
  return (step) => {
    if (step === "create-branch") branchCreation.setOpen(true);
    else if (step === "commit") handleCommit();
    else if (step === "commit-and-push") handleCommit({ push: true });
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

function GitSplitRow({ plan, run, onMenuOpenChange }: {
  plan: GitRowPlan;
  run: (step: GitStep) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  return (
    <SplitButton
      variant="ghost"
      className="w-full"
      menuLabel="More git actions"
      menuBeside="left"
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

function GitEntry() {
  const { gitRow } = useOverviewContext();
  const { held, wrapperProps, setMenuOpen } = useRowHold();
  const plan = useHeldPlan(gitRow, held);
  const run = useRunGitStep();
  if (!plan) return null;
  return (
    <div data-testid="thread-overview-git" {...wrapperProps}>
      {plan.alternates.length > 0 ? (
        <GitSplitRow plan={plan} run={run} onMenuOpenChange={setMenuOpen} />
      ) : (
        <Button
          variant="ghost"
          size="compact"
          type="button"
          data-testid={GIT_STEP_PRESENTATION[plan.main].testId}
          onClick={() => run(plan.main)}
          className={cn(OVERVIEW_ROW_CLASS, "justify-start text-ink")}
        >
          <GitStepContent step={plan.main} />
        </Button>
      )}
    </div>
  );
}

/** The Overview's git row: the thread's next git step, with the other step that fits now in its menu. */
export function GitEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <GitEntry /> : null;
}
