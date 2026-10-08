import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProjectActionMenu, ProjectSetupMenuItem, useProjectActions } from "@/features/projects/environment";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { rightPanelActionTerminalId, useDiffStore } from "@/stores/diffStore";
import { type Thread } from "@/transport";
import { Settings } from "lucide-react";
import { useCallback } from "react";

/** Returns the setup action only when this checkout supports manual setup. */
function getThreadOverviewSetupMenuItem(
  canRunManualSetup: boolean,
  hasSetup: boolean,
  props: React.ComponentProps<typeof ProjectSetupMenuItem>,
): React.ReactNode {
  if (!canRunManualSetup || !hasSetup) return null;
  return <ProjectSetupMenuItem {...props} />;
}

function canRunManualProjectSetup(thread: Thread): boolean {
  return thread.mode === "direct" || (
    thread.mode === "worktree" && thread.worktree_managed === false
  );
}

function useThreadProjectActions(thread: Thread) {
  return useProjectActions(thread.workspace_id, thread.id);
}

/** Keeps loaded project actions and Setup across popover close, as the parent-owned hook did. */
export const { Provider: OverviewProjectActionsState, useEntryState: useProjectActionsState } =
  createOverviewEntryState(useThreadProjectActions);

function ProjectActions({ thread }: { thread: Thread }) {
  const { projectSetup, openProjectSettings } = useOverviewContext();
  const projectActions = useProjectActionsState();
  const startProjectAction = useCallback(async (actionId: string) => {
    const run = await projectActions.start(actionId);
    useDiffStore.getState().ensureRightPanelActionTerminalTab(
      thread.workspace_id,
      thread.id,
      run.actionId,
    );
    return run;
  }, [projectActions, thread.id, thread.workspace_id]);
  const approveProjectAction = useCallback(async (actionId: string, approval: import("@mcode/contracts").WorkspaceEnvironmentCommandApproval) => {
    const run = await projectActions.approve(actionId, approval);
    useDiffStore.getState().ensureRightPanelActionTerminalTab(thread.workspace_id, thread.id, run.actionId);
    return run;
  }, [projectActions, thread.id, thread.workspace_id]);
  const focusProjectAction = useCallback((actionId: string) => {
    const panels = useDiffStore.getState();
    panels.ensureRightPanelActionTerminalTab(thread.workspace_id, thread.id, actionId);
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    panels.setRightPanelTabInstance(
      thread.workspace_id,
      thread.id,
      rightPanelActionTerminalId(actionId),
    );
  }, [thread.id, thread.workspace_id]);
  const canRunManualSetup = canRunManualProjectSetup(thread);
  return (<ProjectActionMenu
    actions={projectActions.actions}
    runsByActionId={projectActions.runsByActionId}
    loadError={projectActions.loadError}
    onStart={startProjectAction}
    onApprove={approveProjectAction}
    onFocus={focusProjectAction}
    onEdit={openProjectSettings}
    setupMenuItem={getThreadOverviewSetupMenuItem(
      canRunManualSetup,
      projectActions.hasSetup,
      {
        attempt: projectSetup.attempt,
        starting: projectSetup.starting,
        onStart: projectSetup.start,
      },
    )}
  />);
}
function ProjectSettings() {
  const { openProjectSettings } = useOverviewContext();
  return (<Tooltip>
    <TooltipTrigger
      render={
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label="Open Project settings"
          onClick={openProjectSettings}
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
/** Project action menu beside the overview title. */
export function OverviewProjectActions({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <ProjectActions thread={subject.thread} /> : null;
}
/** Project settings shortcut beside the overview title. */
export function OverviewProjectSettings({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <ProjectSettings /> : null;
}
