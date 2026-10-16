import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProjectActionMenu, ProjectSetupMenuItem, useProjectActions } from "@/features/projects/environment";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/features/terminal";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { newThreadOverviewKey, useOverviewStore } from "@/stores/overviewStore";
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

/** The record a Project Action runs in, matched by owner first and by the run's session as a fallback. */
function findActionTerminalId(threadId: string, actionId: string): string | null {
  const records = useTerminalStore.getState().terminals[threadId] ?? [];
  const owned = records.find((terminal) => terminal.actionId === actionId);
  if (owned) return owned.id;
  return useProjectActionStore.getState().runsByThread[threadId]?.[actionId]?.terminalSessionId ?? null;
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
  const revealTerminal = useCallback(() => {
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "terminal");
  }, [thread.id, thread.workspace_id]);
  const startProjectAction = useCallback(async (actionId: string) => {
    const run = await projectActions.start(actionId);
    revealTerminal();
    return run;
  }, [projectActions, revealTerminal]);
  const approveProjectAction = useCallback(async (actionId: string, approval: import("@mcode/contracts").WorkspaceEnvironmentCommandApproval) => {
    const run = await projectActions.approve(actionId, approval);
    revealTerminal();
    return run;
  }, [projectActions, revealTerminal]);
  const focusProjectAction = useCallback((actionId: string) => {
    revealTerminal();
    const ptyId = findActionTerminalId(thread.id, actionId);
    if (ptyId) useTerminalStore.getState().setActiveTerminal(thread.id, ptyId);
  }, [revealTerminal, thread.id]);
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
