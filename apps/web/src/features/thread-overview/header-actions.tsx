import { Button, IconButton } from "@/components/ui/button";
import { MoreIcon } from "@/components/ui/icon-map";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThreadActionRunMenu } from "@/features/projects/actions/ThreadActionRunMenu";
import { useProjectActions } from "@/features/projects/actions/useProjectActions";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { newThreadOverviewKey, useOverviewStore } from "@/stores/overviewStore";
import { type Thread } from "@/transport";
import { Settings } from "lucide-react";

function useThreadProjectActions(thread: Thread) {
  return useProjectActions(thread.workspace_id, thread.id);
}

/** Keeps loaded project actions across popover close, as the parent-owned hook did. */
export const { Provider: OverviewProjectActionsState, useEntryState: useProjectActionsState } =
  createOverviewEntryState(useThreadProjectActions);

function ProjectActions({ thread }: { thread: Thread }) {
  const { openProjectSettings } = useOverviewContext();
  const projectActions = useProjectActionsState();
  return (
    <ThreadActionRunMenu
      workspaceId={thread.workspace_id}
      threadId={thread.id}
      projectActions={projectActions}
      onEdit={openProjectSettings}
      trigger={
        <IconButton aria-label="Actions" className="aria-expanded:bg-selected">
          <MoreIcon size={14} aria-hidden />
        </IconButton>
      }
    />
  );
}
function ProjectSettingsButton({ onOpen }: { onOpen: () => void }) {
  return (<Tooltip>
    <TooltipTrigger
      render={
        <Button
          variant="ghost"
          size="icon-compact"
          type="button"
          aria-label="Open Project settings"
          onClick={onOpen}
          className="cursor-pointer text-muted hover:bg-hover/40 hover:text-ink"
        >
          <Settings size={14} aria-hidden />
        </Button>
      }
    />
    <TooltipContent side="bottom" className="text-xs">
      Open Project settings
    </TooltipContent>
  </Tooltip>);
}
function ThreadProjectSettings() {
  return <ProjectSettingsButton onOpen={useOverviewContext().openProjectSettings} />;
}
/** A new thread has no thread-scoped panel yet, so settings open in the workspace's new-thread panel. */
function openNewThreadProjectSettings(workspaceId: string) {
  useOverviewStore.getState().dismissOverlay(newThreadOverviewKey(workspaceId));
  showRightPanelAdaptive(workspaceId, null);
  useDiffStore.getState().setRightPanelTab(workspaceId, null, "environment");
}
/** Project action menu beside the overview title. */
export function OverviewProjectActions({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <ProjectActions thread={subject.thread} /> : null;
}
/** Project settings shortcut beside the overview title. */
export function OverviewProjectSettings({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread"
    ? <ThreadProjectSettings />
    : <ProjectSettingsButton onOpen={() => openNewThreadProjectSettings(subject.workspaceId)} />;
}
