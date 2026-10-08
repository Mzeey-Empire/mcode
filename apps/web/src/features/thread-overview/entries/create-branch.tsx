import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { cn } from "@/lib/utils";
import { GitBranch } from "lucide-react";
import {
  OVERVIEW_ROW_CLASS,
  ThreadOverviewTooltipButton,
  ThreadOverviewWhen,
} from "@/features/thread-overview/overview-row";

function CreateBranchEntry() {
  const { branchCreation, branchlessCreatePr } = useOverviewContext();

  return (<ThreadOverviewWhen when={branchlessCreatePr}>
    <ThreadOverviewTooltipButton content="Create a branch in this worktree">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        data-testid="thread-overview-create-branch"
        className={cn(
          OVERVIEW_ROW_CLASS,
          "cursor-pointer justify-start text-xs text-primary hover:bg-primary/10 hover:text-primary",
        )}
        onClick={() => branchCreation.setOpen(true)}
      >
        <GitBranch size={14} className="shrink-0 text-primary/80" />
        <span className="font-medium">Create branch</span>
      </Button>
    </ThreadOverviewTooltipButton>
  </ThreadOverviewWhen>);
}

/** CreateBranch block in the thread overview, preserving its existing row position. */
export function CreateBranchEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <CreateBranchEntry /> : null;
}
