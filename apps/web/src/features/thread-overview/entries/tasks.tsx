import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { cn } from "@/lib/utils";
import { useTaskProgress, useTaskStore } from "@/stores/taskStore";
import { type Thread } from "@/transport";
import { ListChecks } from "lucide-react";
import { useCallback } from "react";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon } from "@/features/thread-overview/overview-row";

function TasksEntry({ thread }: { thread: Thread }) {
  const progress = useTaskProgress(thread.id);
  const showTrayList = useCallback(() => {
    useTaskStore.getState().setTrayExpanded(thread.id, true);
  }, [thread.id]);
  if (!progress) return null;
  return (
    <Button
      variant="ghost"
      size="compact"
      type="button"
      data-testid="thread-overview-tasks"
      onClick={showTrayList}
      aria-label={`${progress.title}, ${progress.settled} of ${progress.total} done`}
      className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between gap-2")}
    >
      <OverviewRowIcon>
        <ListChecks />
      </OverviewRowIcon>
      <span className="text-fade min-w-0 grow text-ink">{progress.title}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted">
        {progress.settled}/{progress.total}
      </span>
    </Button>
  );
}

/** Task list row in the thread overview. Clicking it opens the composer tray's full list. */
export function TasksEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <TasksEntry thread={subject.thread} /> : null;
}
