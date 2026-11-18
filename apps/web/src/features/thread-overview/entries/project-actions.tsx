import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { Button } from "@/components/ui/button";
import { ActionMenuGlyph, RunHint } from "@/features/projects/actions/ActionRunMenu";
import { ThreadActionRunMenu, useThreadActionRunHandlers } from "@/features/projects/actions/ThreadActionRunMenu";
import { useProjectActions } from "@/features/projects/actions/useProjectActions";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon, ThreadOverviewTooltipButton } from "@/features/thread-overview/overview-row";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { newThreadOverviewKey, useOverviewStore } from "@/stores/overviewStore";
import { type Thread } from "@/transport";
import { ChevronDown, Play, Settings } from "lucide-react";

function useThreadProjectActions(thread: Thread) {
  return useProjectActions(thread.workspace_id, thread.id);
}

/** Keeps loaded project actions across the card closing, so reopening it does not reload them. */
export const { Provider: OverviewProjectActionsState, useEntryState: useProjectActionsState } =
  createOverviewEntryState(useThreadProjectActions);

/** The Action run most recently in this thread, or the project's first Action before any has run. */
export function primaryProjectAction(
  actions: readonly WorkspaceEnvironmentAction[],
  runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>,
): WorkspaceEnvironmentAction | null {
  let latest: { readonly action: WorkspaceEnvironmentAction; readonly createdAt: string } | null = null;
  for (const action of actions) {
    const createdAt = runsByActionId.get(action.id)?.createdAt;
    if (createdAt && (!latest || createdAt > latest.createdAt)) latest = { action, createdAt };
  }
  return latest?.action ?? actions[0] ?? null;
}

/**
 * 38px wide so the centred chevron ends 11px from the row's edge, where the other rows' chevrons
 * end. It takes its own fill while the row is hovered so the second target reads as separate.
 */
const CHEVRON_SEGMENT_CLASS =
  "w-[3.8rem] rounded-l-none group-hover/action-row:bg-selected group-focus-within/action-row:bg-selected aria-expanded:bg-selected";

/** The row's main part: runs the Action, or shows its terminal when it already runs. */
function ProjectActionMain({ action, run, capReason, onRun, onOpen }: {
  readonly action: WorkspaceEnvironmentAction;
  readonly run: WorkspaceEnvironmentActionRun | null;
  readonly capReason: string | null;
  readonly onRun: (actionId: string) => void;
  readonly onOpen: (actionId: string) => void;
}) {
  const live = run?.status === "running" || run?.status === "awaiting-approval";
  const blocked = !live && capReason !== null;
  const button = (
    <Button
      variant="ghost"
      size="compact"
      type="button"
      aria-label={live ? `Open ${action.name}` : `Run ${action.name}`}
      disabled={blocked}
      onClick={() => (live ? onOpen(action.id) : onRun(action.id))}
      className={cn(OVERVIEW_ROW_CLASS, "group/action min-w-0 flex-1 justify-start pr-2 hover:bg-transparent")}
    >
      <OverviewRowIcon>
        <ActionMenuGlyph action={action} running={run?.status === "running"} />
      </OverviewRowIcon>
      <span className="min-w-0 flex-1 text-fade font-medium">{action.name}</span>
      {live ? null : <RunHint />}
    </Button>
  );
  return blocked ? <ThreadOverviewTooltipButton content={capReason} disabled>{button}</ThreadOverviewTooltipButton> : button;
}

/**
 * A split row for the thread's Project Actions: the main part runs {@link primaryProjectAction},
 * and the chevron opens the full Actions menu. Before the Actions load, or when there are none,
 * the whole row opens the menu, which still offers New terminal and Edit actions.
 */
function ProjectActionsRow({ thread }: { readonly thread: Thread }) {
  const { openProjectSettings } = useOverviewContext();
  const projectActions = useProjectActionsState();
  const menuProps = { workspaceId: thread.workspace_id, threadId: thread.id, projectActions, onEdit: openProjectSettings };
  const { terminalCapReason, onRun, onOpen } = useThreadActionRunHandlers(menuProps);
  const primary = primaryProjectAction(projectActions.actions, projectActions.runsByActionId);

  if (!primary) {
    return (
      <ThreadActionRunMenu
        {...menuProps}
        trigger={
          <Button
            variant="ghost"
            size="compact"
            type="button"
            data-testid="thread-overview-project-actions"
            className={cn(OVERVIEW_ROW_CLASS, "justify-between")}
          >
            <span className="flex min-w-0 items-center gap-2">
              <OverviewRowIcon><Play /></OverviewRowIcon>
              <span className="text-fade font-medium">Project actions</span>
            </span>
            <ChevronDown aria-hidden className="-mr-0.5 shrink-0 text-muted" />
          </Button>
        }
      />
    );
  }

  return (
    <div
      data-testid="thread-overview-project-actions"
      className="group/action-row flex rounded-control hover:bg-hover focus-within:bg-hover has-[[aria-expanded=true]]:bg-hover"
    >
      <ProjectActionMain
        action={primary}
        run={projectActions.runsByActionId.get(primary.id) ?? null}
        capReason={terminalCapReason}
        onRun={onRun}
        onOpen={onOpen}
      />
      <ThreadActionRunMenu
        {...menuProps}
        trigger={
          <Button variant="ghost" size="icon-compact" type="button" aria-label="Project actions" className={CHEVRON_SEGMENT_CLASS}>
            <ChevronDown aria-hidden />
          </Button>
        }
      />
    </div>
  );
}

/** A new thread has no thread-scoped panel yet, so settings open in the workspace's new-thread panel. */
function openNewThreadProjectSettings(workspaceId: string) {
  useOverviewStore.getState().dismissOverlay(newThreadOverviewKey(workspaceId));
  showRightPanelAdaptive(workspaceId, null);
  useDiffStore.getState().setRightPanelTab(workspaceId, null, "environment");
}

function NewThreadProjectSettingsRow({ workspaceId }: { readonly workspaceId: string }) {
  return (
    <Button
      variant="ghost"
      size="compact"
      type="button"
      onClick={() => openNewThreadProjectSettings(workspaceId)}
      className={cn(OVERVIEW_ROW_CLASS, "justify-start")}
    >
      <OverviewRowIcon><Settings /></OverviewRowIcon>
      <span className="text-fade font-medium">Project settings</span>
    </Button>
  );
}

/** The card's first row: the thread's Project Actions, or Project settings for a new thread. */
export function ProjectActionsEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread"
    ? <ProjectActionsRow thread={subject.thread} />
    : <NewThreadProjectSettingsRow workspaceId={subject.workspaceId} />;
}
