import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { GitPullRequest } from "lucide-react";
import { ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

function CommitEntry() {
  const { branchlessCreatePr, handleCommit } = useOverviewContext();

  return (<ThreadOverviewWhen when={branchlessCreatePr}>
    <Button
      variant="ghost"
      size="compact"
      type="button"
      data-testid="workspace-menu-commit"
      onClick={handleCommit}
      className="h-8 w-full justify-start gap-2 px-2 text-left text-xs text-ink/75"
    >
      <GitPullRequest size={14} className="shrink-0 text-muted" />
      <span className="font-medium">Commit…</span>
    </Button>
  </ThreadOverviewWhen>);
}

export function CommitEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <CommitEntry /> : null;
}
