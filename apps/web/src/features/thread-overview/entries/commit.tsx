import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { GitPullRequest } from "lucide-react";
import { ThreadOverviewTooltipButton, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

function CommitOrPushEntry() {
  const { branchlessCreatePr } = useOverviewContext();

  return (<ThreadOverviewWhen when={branchlessCreatePr}>
    <ThreadOverviewTooltipButton
      content="Create a branch before committing or pushing"
      disabled
    >
      <Button
        variant="ghost"
        size="compact"
        type="button"
        disabled
        data-testid="workspace-menu-commit"
        className="h-8 w-full justify-start gap-2 px-2 text-left text-xs text-ink/75 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <GitPullRequest size={14} className="shrink-0 text-muted" />
        <span className="font-medium">Commit or push</span>
      </Button>
    </ThreadOverviewTooltipButton>
  </ThreadOverviewWhen>);
}

/** Commit or push block in the thread overview, preserving its existing row position. */
export function CommitOrPushEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <CommitOrPushEntry /> : null;
}
