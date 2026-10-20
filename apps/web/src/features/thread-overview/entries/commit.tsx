import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { cn } from "@/lib/utils";
import { GitPullRequest } from "lucide-react";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

function CommitEntry() {
  const { branchlessCreatePr, handleCommit } = useOverviewContext();

  return (<ThreadOverviewWhen when={branchlessCreatePr}>
    <Button
      variant="ghost"
      size="compact"
      type="button"
      data-testid="workspace-menu-commit"
      onClick={handleCommit}
      className={cn(OVERVIEW_ROW_CLASS, "justify-start text-ink/75")}
    >
      <OverviewRowIcon>
        <GitPullRequest />
      </OverviewRowIcon>
      <span className="font-medium">Commit…</span>
    </Button>
  </ThreadOverviewWhen>);
}

export function CommitEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <CommitEntry /> : null;
}
