import { memo, useCallback, type CSSProperties } from "react";
import { useShallow } from "zustand/shallow";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { KeyboardCode, useDndContext, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { ChevronRight, FolderOpen, GitBranchMinus, Pencil, SquarePen, Trash2 } from "lucide-react";
import type { ChecksStatus } from "@mcode/contracts/github";
import { Button } from "@/components/ui/button";
import { MoreIcon } from "@/components/ui/icon-map";
import { Spinner } from "@/components/ui/spinner";
import { StatusMark } from "@/components/ui/status-mark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectIcon } from "@/features/projects/icons/ProjectIcon";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { threadRowLook, threadRowSetup, threadStartupRecord } from "@/features/thread-attention/thread-row-presentation";
import { deriveThreadRowState, rollUpThreadRowStates, type ThreadRowState } from "@/features/thread-attention/thread-row-state";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { getCiVisual } from "@/lib/ci-status";
import { FILE_EXPLORER_ID } from "@/lib/resolveDefaultOpenInApp";
import { cn } from "@/lib/utils";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useThreadDraftStore } from "@/stores/threadDraftStore";
import { getExecutingThreadIds, useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import type { Workspace } from "@/transport/types";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useSidebarScope } from "./ScopeBar";
import type { SidebarItem } from "./sidebar-model";
import type { SidebarRowContext } from "./sidebar-row-context";
import type { SidebarScope } from "./sidebar-ui-store";

type ProjectItem = Extract<SidebarItem, { kind: "project" }>;

/** Which edge of a project header a dragged project would land on. */
export type DropEdge = "top" | "bottom";

const QUIET_ROW_STATE: ThreadRowState = { kind: "quiet" };
const NO_THREADS: readonly WorkspaceThread[] = [];

function workspaceThreads(threads: readonly WorkspaceThread[], workspaceId: string): readonly WorkspaceThread[] {
  const owned = threads.filter((thread) => thread.workspace_id === workspaceId);
  return owned.length === 0 ? NO_THREADS : owned;
}

function inScope(thread: WorkspaceThread, scope: SidebarScope): boolean {
  return scope === "completed" ? thread.user_completed_at !== null : thread.user_completed_at === null;
}

/** The highest-priority state among a collapsed project's threads, read from the shared row-state stores. */
function useCollapsedStatus(threads: readonly WorkspaceThread[], collapsed: boolean): ThreadRowState {
  const executing = useThreadStore(useShallow(getExecutingThreadIds));
  const pendingStartup = useWorkspaceStore((state) => state.pendingStartupByThreadId);
  const attention = threadAttentionStore((state) => state.byThreadId);
  const onScreenThreadId = threadAttentionStore((state) => state.onScreenThreadId);
  const startups = useThreadStartupStore(useShallow((state) => ({
    recordsByStartupId: state.recordsByStartupId,
    startupIdByThreadId: state.startupIdByThreadId,
  })));
  if (!collapsed) return QUIET_ROW_STATE;
  const running = new Set(executing);
  return rollUpThreadRowStates(threads.map((thread) => deriveThreadRowState({
    attention: attention[thread.id],
    running: running.has(thread.id) || pendingStartup[thread.id] !== undefined || thread.clientPreparing === true,
    setup: threadRowSetup(threadStartupRecord(startups, thread.id)),
    onScreen: onScreenThreadId === thread.id,
  })));
}

type SortableAttributes = ReturnType<typeof useSortable>["attributes"];

/** Sortable metadata safe for the focusable header: role and tabIndex are set explicitly, and
 * aria-pressed and aria-disabled are only valid on buttons. */
function headerSortableAttributes(attributes: SortableAttributes | undefined) {
  if (!attributes) return undefined;
  const {
    role: _role,
    tabIndex: _tabIndex,
    "aria-pressed": _pressed,
    "aria-disabled": _disabled,
    ...rest
  } = attributes;
  return rest;
}

/** A recent-list project header that drags to reorder projects. */
export const SortableProjectRow = memo(function SortableProjectRow({
  item,
  ctx,
  dropEdge,
}: {
  item: ProjectItem;
  ctx: SidebarRowContext;
  dropEdge: DropEdge | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.workspaceId });
  const style: CSSProperties = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    transition,
    ...(isDragging ? { opacity: 0.35, zIndex: "var(--layer-sticky)" } : {}),
  };
  return (
    <div ref={setNodeRef} style={style} className="relative">
      {dropEdge !== null && (
        <div
          data-testid="drop-indicator"
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 z-(--layer-dropdown) h-1 rounded-full bg-primary",
            dropEdge === "top" ? "top-0" : "bottom-0",
          )}
        />
      )}
      <ProjectHeader item={item} ctx={ctx} isDragging={isDragging} sortableListeners={listeners} sortableAttributes={attributes} />
    </div>
  );
});

interface ProjectHeaderProps {
  item: ProjectItem;
  ctx: SidebarRowContext;
  isDragging?: boolean;
  sortableListeners?: DraggableSyntheticListeners;
  sortableAttributes?: SortableAttributes;
}

/** A project header: icon, name, roll-ups, and the hover actions. Also the drag overlay's clone. */
export const ProjectHeader = memo(function ProjectHeader({ item, ctx, isDragging = false, sortableListeners, sortableAttributes }: ProjectHeaderProps) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === item.workspaceId));
  const isActive = useWorkspaceStore((state) => state.activeWorkspaceId === item.workspaceId);
  const threads = useWorkspaceStore(useShallow((state) => workspaceThreads(state.threads, item.workspaceId)));
  // Only headers roll up CI, so only they subscribe; a checks poll must not re-render thread rows.
  const checksById = useWorkspaceStore((state) => state.checksById);
  const scope = useSidebarScope();
  const collapsedStatus = useCollapsedStatus(threads, item.collapsed);
  if (!workspace) return null;
  return (
    <>
      <ProjectWorkspaceRow
        workspace={workspace}
        item={item}
        isActive={isActive}
        isProjectDragging={isDragging}
        sortableListeners={sortableListeners}
        sortableAttributes={sortableAttributes}
        checksById={checksById}
        collapsedStatus={collapsedStatus}
        threads={threads}
        scope={scope}
        ctx={ctx}
      />
      <ProjectEmptyNote item={item} scope={scope} />
    </>
  );
});

function ProjectEmptyNote({ item, scope }: { item: ProjectItem; scope: SidebarScope }) {
  const hasDrafts = useThreadDraftStore((state) => Object.values(state.drafts).some((draft) => draft.workspaceId === item.workspaceId));
  if (item.collapsed || item.count > 0 || item.section !== "recent" || (scope === "active" && hasDrafts)) return null;
  return (
    <p data-testid={`project-empty-${item.workspaceId}`} className="px-9 py-1 font-mono text-xs text-muted/70">
      {scope === "completed" ? "No closed threads" : "No open threads"}
    </p>
  );
}

interface ProjectWorkspaceRowProps {
  workspace: Workspace;
  item: ProjectItem;
  isActive: boolean;
  isProjectDragging: boolean;
  sortableListeners: DraggableSyntheticListeners | undefined;
  sortableAttributes: SortableAttributes | undefined;
  checksById: Readonly<Record<string, ChecksStatus>>;
  collapsedStatus: ThreadRowState;
  threads: readonly WorkspaceThread[];
  scope: SidebarScope;
  ctx: SidebarRowContext;
}

function useProjectActions(workspace: Workspace, section: ProjectItem["section"], ctx: SidebarRowContext) {
  const toggle = useCallback(() => ctx.onToggleProject(workspace.id, section), [ctx, workspace.id, section]);
  const createThread = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    ctx.onCreateThread(workspace.id);
  }, [ctx, workspace.id]);
  const deleteProject = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    ctx.onDeleteProject(workspace.id);
  }, [ctx, workspace.id]);
  const renameProject = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    ctx.onRenameProject(workspace);
  }, [ctx, workspace]);
  const openInExplorer = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void getTransport().openIn(FILE_EXPLORER_ID, workspace.path).catch((error: unknown) => {
      useToastStore.getState().show({
        kind: "failed",
        title: "Couldn't open File Explorer",
        meta: error instanceof Error ? error.message : String(error),
      });
    });
  }, [workspace.path]);
  return { toggle, createThread, deleteProject, renameProject, openInExplorer };
}

function ProjectWorkspaceRow({
  workspace,
  item,
  isActive,
  isProjectDragging,
  sortableListeners,
  sortableAttributes,
  checksById,
  collapsedStatus,
  threads,
  scope,
  ctx,
}: ProjectWorkspaceRowProps) {
  const actions = useProjectActions(workspace, item.section, ctx);
  const visibleThreads = threads.filter((thread) => inScope(thread, scope));
  return (
    <div
      // The sortable metadata (roledescription, keyboard-instructions ref)
      // must sit on the focusable activator, not an unfocusable wrapper, or
      // screen readers never announce the drag affordance. role stays "group"
      // because the row contains nested buttons; the DragOverlay clone gets no
      // sortable attributes and drops out of the tab order.
      {...headerSortableAttributes(sortableAttributes)}
      role="group"
      tabIndex={sortableAttributes ? 0 : -1}
      aria-label={projectGroupLabel(workspace, item.count)}
      data-testid={`project-row-${workspace.id}`}
      onClick={actions.toggle}
      className={cn(
        "group/ws relative flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-body-small touch-none outline-none focus-visible:ring-2 focus-visible:ring-focus/70 has-[[data-project-title]:focus-visible]:ring-2 has-[[data-project-title]:focus-visible]:ring-focus/70",
        isProjectDragging && "cursor-grabbing",
        isActive ? "text-ink" : "text-muted hover:bg-selected/40 hover:text-ink",
      )}
      {...sortableListeners}
    >
      <ProjectIcon workspaceId={workspace.id} name={workspace.name} size={16} className="shrink-0" />
      <ProjectTitle workspace={workspace} onClick={actions.toggle} />
      <ProjectGitStatus isGitRepository={workspace.is_git_repo} />
      <WorkspaceCiRollupChip threads={visibleThreads} checksById={checksById} />
      <ProjectCollapsedStatus status={collapsedStatus} />
      <ProjectThreadCount workspaceId={workspace.id} count={item.count} />
      <ProjectRowActions
        workspace={workspace}
        isExpanded={!item.collapsed}
        onToggle={actions.toggle}
        onOpenInExplorer={actions.openInExplorer}
        onRename={actions.renameProject}
        onDelete={actions.deleteProject}
        onCreateThread={actions.createThread}
      />
    </div>
  );
}

// Counts the same threads as the visible number: those this section lists for the project.
function projectGroupLabel(workspace: Workspace, count: number): string {
  return `${workspace.name} project, ${count} ${count === 1 ? "thread" : "threads"}`;
}

/**
 * Workspace-row CI roll-up chip.
 *
 * Silent-on-healthy: renders nothing when all threads are green (or none have CI).
 * Surfaces a single chip when any thread is failing or pending, so a collapsed
 * project row still shouts when something needs attention but stays quiet when
 * nothing does. Uses the shared CI chrome so it stays consistent with the
 * chat-header button and overview popover.
 */
const WorkspaceCiRollupChip = memo(function WorkspaceCiRollupChip({
  threads,
  checksById,
}: {
  threads: readonly WorkspaceThread[];
  checksById: Readonly<Record<string, ChecksStatus>>;
}) {
  const rollup = workspaceCiRollup(threads, checksById);
  if (!rollup) return null;
  const { icon: Icon, chromeClass } = getCiVisual(rollup.aggregate);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={rollup.label}
            className={cn(
              "shrink-0 inline-flex items-center gap-0.5 px-1 h-4 rounded-[3px] border transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none",
              "text-caption font-medium tabular-nums",
              chromeClass,
            )}
          >
            {Icon === null ? (
              <Spinner size={12} className="text-current" />
            ) : (
              <Icon size={9} className="shrink-0" />
            )}
            <span>{rollup.count}</span>
          </span>
        }
      />
      <TooltipContent>{rollup.label}</TooltipContent>
    </Tooltip>
  );
});

function workspaceCiRollup(
  threads: readonly WorkspaceThread[],
  checksById: Readonly<Record<string, ChecksStatus>>,
): { aggregate: "failing" | "pending"; count: number; label: string } | null {
  let failingCount = 0;
  let pendingCount = 0;
  for (const thread of threads) {
    const checks = checksById[thread.id];
    if (!checks || checks.aggregate === "no_checks") continue;
    if (checks.aggregate === "failing") failingCount += 1;
    if (checks.aggregate === "pending") pendingCount += 1;
  }
  if (failingCount > 0) return ciRollupStatus("failing", failingCount);
  if (pendingCount > 0) return ciRollupStatus("pending", pendingCount);
  return null;
}

function ciRollupStatus(
  aggregate: "failing" | "pending",
  count: number,
): { aggregate: "failing" | "pending"; count: number; label: string } {
  const noun = count === 1 ? "thread" : "threads";
  const label = aggregate === "failing"
    ? `${count} ${noun} failing`
    : `${count} ${noun} with checks running`;
  return { aggregate, count, label };
}

// The KeyboardSensor's default start keys. Stopping them keeps a nested button's Enter or Space
// from starting a keyboard drag on the row; every other key, Escape above all, must still reach
// the document, where the PointerSensor listens for it to cancel a pointer drag.
const DRAG_START_CODES: ReadonlySet<string> = new Set([KeyboardCode.Enter, KeyboardCode.Space]);

function stopDragStartKeys(event: React.KeyboardEvent): void {
  if (DRAG_START_CODES.has(event.code)) event.stopPropagation();
}

function ProjectTitle({ workspace, onClick }: { workspace: Workspace; onClick: () => void }) {
  // A title tooltip opened by hover would otherwise ride along with the drag and clip at the edge.
  const dragging = useDndContext().active !== null;
  return (
    <Tooltip disabled={dragging}>
      <TooltipTrigger render={
        <Button data-project-title type="button" variant="ghost" size="compact" aria-label={`Open project ${workspace.name}`} onKeyDown={stopDragStartKeys} onClick={(event) => { event.stopPropagation(); onClick(); }} className="h-auto min-w-0 flex-1 shrink justify-start rounded-sm p-0 text-left hover:bg-transparent group-hover/ws:pr-24 group-focus-within/ws:pr-24 focus-visible:outline-none dark:hover:bg-transparent">
          <span className="flex-1 text-fade font-medium tracking-tight">{workspace.name}</span>
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">{workspace.name}</TooltipContent>
    </Tooltip>
  );
}

function ProjectGitStatus({ isGitRepository }: { isGitRepository: boolean }) {
  if (isGitRepository) return null;
  return <Tooltip><TooltipTrigger render={<GitBranchMinus size={12} className="shrink-0 text-muted/45" aria-label="Not a git repository" />} /><TooltipContent side="right" className="text-xs">Not a git repository</TooltipContent></Tooltip>;
}

function ProjectCollapsedStatus({ status }: { status: ThreadRowState }) {
  const { mark } = threadRowLook(status);
  if (!mark) return null;
  return (
    <span className="flex shrink-0 transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none">
      <StatusMark state={mark.state} label={mark.label} />
    </span>
  );
}

function ProjectThreadCount({ workspaceId, count }: { workspaceId: string; count: number }) {
  if (count === 0) return null;
  return <span data-testid={`project-thread-count-${workspaceId}`} className="ml-auto flex h-4 min-w-3 shrink-0 items-center justify-end font-mono text-xs leading-4 tabular-nums text-muted/45 transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none">{count}</span>;
}

function ProjectRowActions({
  workspace,
  isExpanded,
  onToggle,
  onOpenInExplorer,
  onRename,
  onDelete,
  onCreateThread,
}: { workspace: Workspace; isExpanded: boolean; onToggle: () => void; onOpenInExplorer: (event: React.MouseEvent) => void; onRename: (event: React.MouseEvent) => void; onDelete: (event: React.MouseEvent) => void; onCreateThread: (event: React.MouseEvent) => void }) {
  return (
    <div data-testid={`project-row-actions-${workspace.id}`} className="pointer-events-none absolute inset-y-0 right-1.5 z-(--layer-dropdown) flex items-center justify-end gap-1 bg-transparent px-0.5 opacity-0 transition-opacity duration-150 group-hover/ws:pointer-events-auto group-hover/ws:opacity-100 group-focus-within/ws:pointer-events-auto group-focus-within/ws:opacity-100 motion-reduce:transition-none">
      <Button type="button" variant="ghost" size="icon-compact" aria-label={`Toggle threads for ${workspace.name}`} aria-expanded={isExpanded} onKeyDown={stopDragStartKeys} onClick={(event) => { event.stopPropagation(); onToggle(); }} className="size-6 shrink-0 text-muted opacity-0 transition-opacity hover:bg-transparent hover:text-muted dark:hover:bg-transparent group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 focus:opacity-100">
        <ChevronRight size={14} className={cn("transition-transform duration-150 motion-reduce:transition-none", isExpanded && "rotate-90")} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`Project options for ${workspace.name}`} onClick={(event) => event.stopPropagation()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted opacity-0 outline-none transition-colors hover:bg-background/60 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/70 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100"><MoreIcon size={13} /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
          <DropdownMenuItem label="Open in Explorer" icon={<FolderOpen />} onClick={onOpenInExplorer} />
          <DropdownMenuItem label="Rename project" icon={<Pencil />} onClick={onRename} />
          <DropdownMenuSeparator />
          <DropdownMenuItem label="Delete project" icon={<Trash2 />} destructive onClick={onDelete} />
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-compact" aria-label={`New thread in ${workspace.name}`} onKeyDown={stopDragStartKeys} onClick={onCreateThread} className="opacity-0 text-muted hover:bg-background/60 hover:text-ink group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 focus:opacity-100"><SquarePen className="size-[1.4rem]" /></Button>}
        />
        <TooltipContent>{`New thread in ${workspace.name}`}</TooltipContent>
      </Tooltip>
    </div>
  );
}
