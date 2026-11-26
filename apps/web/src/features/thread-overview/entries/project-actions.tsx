import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { Button, IconButton } from "@/components/ui/button";
import { ActionMenuGlyph } from "@/features/projects/actions/ActionRunMenu";
import { ThreadActionRunMenu, useThreadActionRunHandlers } from "@/features/projects/actions/ThreadActionRunMenu";
import { useProjectActions } from "@/features/projects/actions/useProjectActions";
import { useIsNoProjectWorkspace } from "@/features/projects/state/workspace-selectors";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import {
  OVERVIEW_ROW_CLASS,
  OVERVIEW_SPLIT_CHEVRON_CLASS,
  OVERVIEW_SPLIT_MAIN_CLASS,
  OverviewRowIcon,
  ThreadOverviewTooltipButton,
} from "@/features/thread-overview/overview-row";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { overviewSubjectWorkspaceId, type OverviewSubject } from "@/features/thread-overview/overview-subject";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { newThreadOverviewKey, useOverviewStore } from "@/stores/overviewStore";
import { type Thread } from "@/transport";
import { ChevronDown, Play, Settings, SquareTerminal } from "lucide-react";

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

/** What a live Action's row says at rest; its click opens the Action's terminal. */
const LIVE_STATUS_LABEL = { running: "Running", "awaiting-approval": "Approval required" } as const;

type LiveStatus = keyof typeof LIVE_STATUS_LABEL;

function liveStatus(run: WorkspaceEnvironmentActionRun | null): LiveStatus | null {
  return run?.status === "running" || run?.status === "awaiting-approval" ? run.status : null;
}

const HINT_TONE_CLASS = "shrink-0 text-caption text-muted group-hover/action:text-ink group-focus-visible/action:text-ink";

/**
 * The main part's trailing hint. Unlike the menu's, it shows at rest, so the row reads as an action
 * rather than a picker like the rows below it. A live Action names its state instead, and on hover
 * or focus says the click now opens its terminal. Both labels share one grid cell, so the hint keeps
 * the wider one's width and the Action's name does not shift as they swap.
 */
function ProjectActionHint({ status }: { readonly status: LiveStatus | null }) {
  if (status === null) {
    return <span aria-hidden className={cn(HINT_TONE_CLASS, "flex items-center gap-1")}><Play className="size-3" />Run</span>;
  }
  return (
    <span aria-hidden className={cn(HINT_TONE_CLASS, "grid justify-items-end")}>
      <span className="col-start-1 row-start-1 group-hover/action:invisible group-focus-visible/action:invisible">
        {LIVE_STATUS_LABEL[status]}
      </span>
      <span className="invisible col-start-1 row-start-1 flex items-center gap-1 group-hover/action:visible group-focus-visible/action:visible">
        <SquareTerminal className="size-3" />Open
      </span>
    </span>
  );
}

/** The row's main part: runs the Action, or shows its terminal when it already runs. */
function ProjectActionMain({ action, run, capReason, onRun, onOpen }: {
  readonly action: WorkspaceEnvironmentAction;
  readonly run: WorkspaceEnvironmentActionRun | null;
  readonly capReason: string | null;
  readonly onRun: (actionId: string) => void;
  readonly onOpen: (actionId: string) => void;
}) {
  const status = liveStatus(run);
  const blocked = status === null && capReason !== null;
  const button = (
    <Button
      variant="ghost"
      size="compact"
      type="button"
      aria-label={status ? `Open ${action.name}, ${LIVE_STATUS_LABEL[status].toLowerCase()}` : `Run ${action.name}`}
      disabled={blocked}
      onClick={() => (status ? onOpen(action.id) : onRun(action.id))}
      className={cn(OVERVIEW_ROW_CLASS, OVERVIEW_SPLIT_MAIN_CLASS, "group/action min-w-0 flex-1 justify-start pr-2")}
    >
      <OverviewRowIcon>
        <ActionMenuGlyph action={action} status={status} />
      </OverviewRowIcon>
      <span className="min-w-0 flex-1 text-fade font-medium">{action.name}</span>
      <ProjectActionHint status={status} />
    </Button>
  );
  if (!blocked) return button;
  // The tooltip's wrapper stands in for the button in the row, so it takes the button's share of the width.
  return <ThreadOverviewTooltipButton content={capReason} disabled className="min-w-0 flex-1">{button}</ThreadOverviewTooltipButton>;
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
      className="flex rounded-control"
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
          <Button variant="ghost" size="icon-compact" type="button" aria-label="Project actions" className={OVERVIEW_SPLIT_CHEVRON_CLASS}>
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

function ProjectSettingsButton({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <IconButton aria-label="Open Project settings" onClick={onOpen}>
      <Settings aria-hidden />
    </IconButton>
  );
}

function ThreadProjectSettingsButton() {
  return <ProjectSettingsButton onOpen={useOverviewContext().openProjectSettings} />;
}

/** Project settings shortcut beside the Overview title, for a thread or a new thread. */
export function OverviewProjectSettingsButton({ subject }: { subject: OverviewSubject }) {
  const noProject = useIsNoProjectWorkspace(overviewSubjectWorkspaceId(subject));
  if (noProject) return null;
  return subject.kind === "thread"
    ? <ThreadProjectSettingsButton />
    : <ProjectSettingsButton onOpen={() => openNewThreadProjectSettings(subject.workspaceId)} />;
}

/** The card's first row: the thread's Project Actions. A new thread has none to run yet. */
export function ProjectActionsEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <ProjectActionsRow thread={subject.thread} /> : null;
}
