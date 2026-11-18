import { cloneElement, forwardRef, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { Archive, ArchiveRestore, Laptop, RefreshCw, Undo2 } from "lucide-react";
import { rankPullRequests } from "@mcode/contracts/models/thread-pull-request";
import { MoreIcon } from "@/components/ui/icon-map";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";
import { ProviderIcon, ProviderIconStack, providerLabel } from "@/components/ui/provider-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cancelPrefetch, prefetchOnPointerDown, schedulePrefetch } from "@/features/conversation";
import { ProjectIcon } from "@/features/projects/icons/ProjectIcon";
import { STATUS_LABEL_TEXT_CLASS, StatusMark } from "@/components/ui/status-mark";
import { THREAD_STATUS_LOOK, threadRowLook, threadTitleTone, useThreadRowState, type ThreadRowLook, type ThreadStatusLook, type ThreadTitleTone } from "@/features/thread-attention/thread-row-presentation";
import type { ThreadRowState } from "@/features/thread-attention/thread-row-state";
import { isPrable } from "@/lib/is-prable";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { useRelativeTime } from "@/lib/time";
import { reactProfilingEnabled } from "@/performance/ReactPerformanceProfiler";
import { cn } from "@/lib/utils";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { draftHasNoSendableContent, useComposerDraftStore } from "@/stores/composerDraftStore";
import type { Thread, Workspace } from "@/transport/types";
import { useWorkspaceStore } from "../state/workspaceStore";
import { selectThreadIndex } from "../state/thread-index";
import { IDLE_CLEANUP_RETRY, useRowLifecycleStore } from "./row-lifecycle-store";
import type { SidebarItem, ThreadTreeLine } from "./sidebar-model";
import type { InlineEditState, SidebarProviderAvailability, SidebarRowContext } from "./sidebar-row-context";
import { PullRequestChip } from "./PullRequestChip";
import { lifecycleActionBlocked, lifecycleBlockedReason, useCompletionStore } from "./completion-store";
import { selectClosedScope, useSidebarUiStore } from "./sidebar-ui-store";
import { THREAD_PREVIEW_ID, ThreadPreviewHandleContext } from "./SidebarThreadPreview";
import type { CompletionEntry } from "./completion-machine";
import { ThreadOptionsMenu, useThreadMenuOpenFor, type ThreadMenuActions } from "./thread-menu";
import { DraftTag, IconOnlyStatus, SidebarLabelTrigger, useSidebarNarrow, useSidebarStatusIconOnly } from "./sidebar-label-tooltip";
import { HOVER_ROW_PROPS } from "./hover-glide";

type ThreadItem = Extract<SidebarItem, { kind: "thread" }>;

interface ThreadRowHandlers {
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onThreadClick: (threadId: string) => void;
  onThreadDoubleClick: (threadId: string) => void;
  onSelectThread: (id: string) => void;
  onThreadContextMenu: (e: React.MouseEvent, thread: Thread) => void;
  threadMenuActions: ThreadMenuActions;
  workspacePath: string;
}

/**
 * One sidebar thread row. It reads its thread and project by id, so a push for another thread
 * never re-renders it.
 */
export const SidebarThreadRow = memo(function SidebarThreadRow({ item, ctx }: { item: ThreadItem; ctx: SidebarRowContext }) {
  const thread = useWorkspaceStore((s) => selectThreadIndex(s.threads).get(item.threadId));
  const workspace = useWorkspaceStore((s) => (thread ? s.workspaces.find((candidate) => candidate.id === thread.workspace_id) : undefined));
  if (!thread) return null;
  return <ThreadRow thread={thread} workspace={workspace} depth={item.depth} treeLine={item.treeLine} showProject={item.layout === "flat"} ctx={ctx} />;
});

/** The selected thread's draft is the text the user is typing now, so it is tagged once they leave. */
function useDraftTagShown(threadId: string, isActive: boolean): boolean {
  return useHasUnsentDraft(threadId) && !isActive;
}

function useThreadRowHandlers(ctx: SidebarRowContext, workspaceId: string, workspacePath: string): ThreadRowHandlers {
  return useMemo(() => ({
    onInlineEditChange: ctx.onInlineEditChange,
    onInlineEditCommit: ctx.onInlineEditCommit,
    onInlineEditCancel: ctx.onInlineEditCancel,
    onThreadClick: (threadId: string) => ctx.onThreadClick(workspaceId, threadId),
    onThreadDoubleClick: ctx.onThreadDoubleClick,
    onSelectThread: (threadId: string) => ctx.onSelectThread(workspaceId, threadId),
    onThreadContextMenu: (event: React.MouseEvent, clicked: Thread) => ctx.onThreadContextMenu(event, clicked, workspacePath),
    threadMenuActions: ctx.threadMenuActions,
    workspacePath,
  }), [ctx, workspaceId, workspacePath]);
}

function ThreadRow({ thread, workspace, depth, treeLine, showProject, ctx }: { thread: WorkspaceThread; workspace: Workspace | undefined; depth: number; treeLine: ThreadTreeLine; showProject: boolean; ctx: SidebarRowContext }) {
  if (reactProfilingEnabled) window.__mcodeReactPerformanceSink?.recordRowRender(`sidebar-thread:${thread.id}`);
  const isEditing = ctx.inlineEdit?.threadId === thread.id;
  const handlers = useThreadRowHandlers(ctx, thread.workspace_id, workspace?.path ?? "");
  const isActive = useWorkspaceStore((s) => s.activeThreadId === thread.id);
  const isRunning = useThreadStore((s) => isThreadExecuting(thread.id, s));
  const startupPending = useWorkspaceStore((s) => s.pendingStartupByThreadId[thread.id] !== undefined);
  const rowState = useThreadRowState(thread.id, thread.clientPreparing === true, thread.clientError != null);
  const completion = useCompletionStore((s) => s.entries.get(thread.id));
  const hasDraft = useDraftTagShown(thread.id, isActive);
  const closedScope = useSidebarUiStore(selectClosedScope);
  const presentation = createThreadRowPresentation(thread, rowState, ctx, { startupPending, isActive, closedScope }, completion);
  const lifecycle = useThreadLifecycleActions({
    thread,
    isEditing,
    isRunning,
    awaitingApproval: rowState.kind === "needs-you" && rowState.label === "Approval required",
    startupPending,
    lifecycleKind: presentation.lifecycleKind,
    cleanupBlocked: presentation.cleanupBlocked,
    onReopenThread: ctx.onReopenThread,
    onRetryThreadCleanup: ctx.onRetryThreadCleanup,
  });
  useCancelEditOnUnmount(isEditing, ctx.onInlineEditCancel);
  return (
    <ThreadRowVisual
      {...handlers}
      workspaceName={workspace?.name ?? ""}
      thread={thread}
      depth={depth}
      treeLine={treeLine}
      showProject={showProject}
      isEditing={isEditing}
      inlineEdit={isEditing ? ctx.inlineEdit : null}
      isActive={isActive}
      hasDraft={hasDraft}
      presentation={presentation}
      lifecycle={lifecycle}
    />
  );
}

function useHasUnsentDraft(threadId: string): boolean {
  return useComposerDraftStore((state) => {
    const draft = state.drafts[threadId];
    return draft !== undefined && !draftHasNoSendableContent(draft);
  });
}

// Blur cancels an inline rename; virtualization unmounts a row without ever firing blur, so
// leaving the DOM mid-edit cancels it instead of stashing a detached draft that would reappear.
function useCancelEditOnUnmount(isEditing: boolean, onCancel: () => void): void {
  const isEditingRef = useRef(isEditing);
  const cancelEditRef = useRef(onCancel);
  useEffect(() => {
    isEditingRef.current = isEditing;
    cancelEditRef.current = onCancel;
  });
  useEffect(
    () => () => {
      if (isEditingRef.current) cancelEditRef.current();
    },
    [],
  );
}

interface ThreadRowPresentation {
  look: ThreadRowLook;
  titleTone: ThreadTitleTone;
  isStaleWorktree: boolean;
  provider: string;
  unusable: boolean;
  unusableReason: string;
  scaffoldDim: string | false;
  closedRow: boolean;
  cleanupBlocked: boolean;
  completing: boolean;
  completionFailure: string | null;
  lifecycleKind: ThreadLifecycleKind;
}

type ThreadLifecycleKind = "complete" | "undo" | "retry" | "reopen";

function lifecycleKindOf(completion: CompletionEntry | undefined, isUserCompleted: boolean): ThreadLifecycleKind {
  if (completion?.phase === "failed") return "retry";
  if (completion) return "undo";
  return isUserCompleted ? "reopen" : "complete";
}

interface ThreadRowLifecycleActions {
  isLifecyclePending: boolean;
  isCleanupRetryPending: boolean;
  cleanupStatusLabel: string | null;
  cleanupRetryFailed: boolean;
  lifecycleUnavailable: boolean;
  closeHidden: boolean;
  handleLifecycleClick: (event: React.MouseEvent) => Promise<void>;
  handleCleanupRetry: (event: React.MouseEvent) => Promise<void>;
}

interface ThreadRowVisualProps {
  workspaceName: string;
  thread: WorkspaceThread;
  depth: number;
  treeLine: ThreadTreeLine;
  /** The flat Threads view has no project header, so each row names its project. */
  showProject: boolean;
  isEditing: boolean;
  inlineEdit: InlineEditState | null;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onThreadClick: (threadId: string) => void;
  onThreadDoubleClick: (threadId: string) => void;
  onSelectThread: (id: string) => void;
  onThreadContextMenu: (event: React.MouseEvent, thread: Thread) => void;
  threadMenuActions: ThreadMenuActions;
  workspacePath: string;
  isActive: boolean;
  hasDraft: boolean;
  presentation: ThreadRowPresentation;
  lifecycle: ThreadRowLifecycleActions;
}

function createThreadRowPresentation(
  thread: WorkspaceThread,
  rowState: ThreadRowState,
  ctx: Pick<SidebarRowContext, "worktreesLoadedFor" | "validWorktreePaths" | "availableProviders">,
  { startupPending, isActive, closedScope }: { startupPending: boolean; isActive: boolean; closedScope: boolean },
  completion: CompletionEntry | undefined,
): ThreadRowPresentation {
  const isUserCompleted = thread.user_completed_at !== null;
  return {
    look: threadRowLook(rowState),
    titleTone: threadTitleTone(rowState, isActive),
    isStaleWorktree: hasStaleThreadWorktree(thread, ctx.worktreesLoadedFor, ctx.validWorktreePaths),
    ...threadProviderPresentation(thread.provider, ctx.availableProviders),
    scaffoldDim: thread.clientPreparing || thread.clientError || startupPending ? "opacity-[0.72]" : false,
    closedRow: closedScope,
    cleanupBlocked: isUserCompleted && thread.cleanup_state === "blocked",
    completing: completion !== undefined && completion.phase !== "failed",
    completionFailure: completion?.phase === "failed" ? completion.failure.message : null,
    lifecycleKind: lifecycleKindOf(completion, isUserCompleted),
  };
}

function hasStaleThreadWorktree(
  thread: WorkspaceThread,
  worktreesLoadedFor: string | null,
  validWorktreePaths: ReadonlySet<string>,
): boolean {
  if (worktreesLoadedFor !== thread.workspace_id || thread.mode !== "worktree") return false;
  if (!thread.worktree_path) return false;
  const path = thread.worktree_path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return !validWorktreePaths.has(path);
}

function threadProviderPresentation(
  provider: string,
  availableProviders: readonly SidebarProviderAvailability[],
): Pick<ThreadRowPresentation, "provider" | "unusable" | "unusableReason"> {
  const providerRow = availableProviders.find((candidate) => candidate.id === provider);
  if (!providerRow) {
    return { provider, unusable: false, unusableReason: "" };
  }
  const unusable = !providerRow.enabled || providerRow.cli.status === "not_found";
  const unusableReason = providerRow.enabled ? "CLI not found" : "Provider disabled";
  return { provider, unusable, unusableReason };
}

function useThreadLifecycleActions({
  thread,
  isEditing,
  isRunning,
  awaitingApproval,
  startupPending,
  lifecycleKind,
  cleanupBlocked,
  onReopenThread,
  onRetryThreadCleanup,
}: Pick<SidebarRowContext, "onReopenThread" | "onRetryThreadCleanup"> & {
  thread: WorkspaceThread;
  isEditing: boolean;
  isRunning: boolean;
  awaitingApproval: boolean;
  startupPending: boolean;
  lifecycleKind: ThreadLifecycleKind;
  cleanupBlocked: boolean;
}): ThreadRowLifecycleActions {
  const isLifecyclePending = useRowLifecycleStore((state) => state.pendingLifecycle.has(thread.id));
  const cleanupRetry = useRowLifecycleStore((state) => state.cleanupRetry.get(thread.id) ?? IDLE_CLEANUP_RETRY);
  const isCleanupRetryPending = cleanupRetry.pending;
  const cleanupRetryError = cleanupRetry.error;
  const lifecycleUnavailable = lifecycleBlockedReason(thread, {
    running: isRunning,
    awaitingApproval,
    startupPending,
    lifecyclePending: isLifecyclePending,
    renaming: isEditing,
  }) !== null;
  const handleLifecycleClick = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    const completions = useCompletionStore.getState();
    if (lifecycleKind === "undo") return completions.undo(thread.id);
    if (lifecycleUnavailable || lifecycleActionBlocked(thread.id)) return;
    if (lifecycleKind === "retry") return completions.retry(thread.id);
    if (lifecycleKind === "complete") return completions.complete(thread.id);
    await reopenWithPendingFlag(thread.id, onReopenThread);
  }, [lifecycleKind, lifecycleUnavailable, onReopenThread, thread.id]);
  const handleCleanupRetry = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!cleanupBlocked || useRowLifecycleStore.getState().cleanupRetry.get(thread.id)?.pending) return;
    useRowLifecycleStore.getState().setCleanupRetry(thread.id, { pending: true, error: null });
    try {
      await onRetryThreadCleanup(thread.id);
      useRowLifecycleStore.getState().setCleanupRetry(thread.id, null);
    } catch (cause: unknown) {
      // A sidebar unmount mid-flight resets the store; writing here would leave a
      // phantom error that the next mount renders.
      if (useRowLifecycleStore.getState().cleanupRetry.has(thread.id)) {
        useRowLifecycleStore.getState().setCleanupRetry(thread.id, { pending: false, error: String(cause) });
      }
    }
  }, [cleanupBlocked, onRetryThreadCleanup, thread.id]);
  return {
    isLifecyclePending,
    isCleanupRetryPending,
    cleanupStatusLabel: cleanupStatusLabel(cleanupRetryError, thread.cleanup_state),
    cleanupRetryFailed: cleanupRetryError !== null,
    lifecycleUnavailable,
    closeHidden: lifecycleUnavailable && lifecycleKind === "complete",
    handleLifecycleClick,
    handleCleanupRetry,
  };
}

async function reopenWithPendingFlag(threadId: string, onReopenThread: (threadId: string) => Promise<void>): Promise<void> {
  useRowLifecycleStore.getState().setLifecyclePending(threadId, true);
  try {
    await onReopenThread(threadId);
  } catch {
    // The store action already surfaces the failure via workspaceStore.error;
    // swallowing here keeps expected rejections (e.g. a pending mutation when
    // a turn raced the click) out of the unhandled-rejection crash reporter.
  } finally {
    useRowLifecycleStore.getState().setLifecyclePending(threadId, false);
  }
}

function cleanupStatusLabel(retryError: string | null, cleanupState: WorkspaceThread["cleanup_state"]): string | null {
  if (retryError) return `Cleanup retry failed: ${retryError}`;
  if (cleanupState === "queued") return "Cleanup queued";
  if (cleanupState === "retrying") return "Retrying cleanup";
  return null;
}

function ThreadRowVisual(props: ThreadRowVisualProps) {
  const [revealed, setRevealed] = useState(false);
  const { thread, presentation } = props;
  const variant: ThreadRowVariant = presentation.closedRow ? "closed" : props.showProject ? "flat" : "grouped";
  const row = (
    <ThreadRowSurface
      thread={thread}
      depth={props.depth}
      treeLine={props.treeLine}
      variant={variant}
      isActive={props.isActive}
      isEditing={props.isEditing}
      onThreadClick={props.onThreadClick}
      onThreadDoubleClick={props.onThreadDoubleClick}
      onSelectThread={props.onSelectThread}
      onThreadContextMenu={props.onThreadContextMenu}
      onRevealChange={setRevealed}
      onMouseEnter={() => useCompletionStore.getState().pointerEntered(thread.id)}
      onMouseLeave={() => useCompletionStore.getState().pointerLeft(thread.id)}
    >
      {variant === "closed" && <ClosedThreadRowBody {...props} revealed={revealed} />}
      {variant === "flat" && <FlatThreadRowBody {...props} revealed={revealed} />}
      {variant === "grouped" && <GroupedThreadRowBody {...props} revealed={revealed} />}
    </ThreadRowSurface>
  );
  return <ThreadRowPreview isEditing={props.isEditing} row={row} workspaceName={props.workspaceName} thread={thread} />;
}

type ThreadRowBodyProps = ThreadRowVisualProps & { revealed: boolean };

function ThreadPullRequestChip({ thread }: { thread: WorkspaceThread }) {
  const ranked = useMemo(() => (isPrable(thread) ? rankPullRequests(thread.pull_requests) : []), [thread]);
  return <PullRequestChip threadId={thread.id} ranked={ranked} />;
}

function FlatThreadRowBody(props: ThreadRowBodyProps) {
  const { thread, presentation } = props;
  const narrow = useSidebarNarrow();
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div data-testid="thread-line-project" className="flex h-4 min-w-0 items-center gap-1 text-caption text-muted">
        <ProjectIcon
          workspaceId={thread.workspace_id}
          name={props.workspaceName}
          size={16}
          tone="tinted"
          className={presentation.titleTone === "receded" ? RECEDED_BADGE_CLASS : undefined}
        />
        <span className={cn("text-fade min-w-0 flex-1", presentation.scaffoldDim)}>{props.workspaceName}</span>
        <ThreadRowTrailingSlot {...props} status={<ThreadRowStatus {...props} iconOnly={narrow} fallback={<ThreadRowTime thread={thread} />} />} />
      </div>
      <ThreadRowTitleLine {...props} className="mt-2" />
      <ThreadRowMetaLine thread={thread} presentation={presentation} chip={<ThreadPullRequestChip thread={thread} />} />
    </div>
  );
}

function GroupedThreadRowBody(props: ThreadRowBodyProps) {
  const { thread, presentation } = props;
  const narrow = useSidebarNarrow();
  // The meta line shares its width with the branch, so the status word yields earlier here than
  // in the Threads view, whose status sits on the roomier project line.
  const statusIconOnly = useSidebarStatusIconOnly();
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ThreadRowTitleLine {...props} iconOnlyDraft={narrow} />
      {/* The status sits on the meta line, so a long title keeps the full width of its own line. */}
      <ThreadRowMetaLine
        thread={thread}
        presentation={presentation}
        chip={<ThreadPullRequestChip thread={thread} />}
        trailing={<ThreadRowTrailingSlot {...props} status={<ThreadRowStatus {...props} iconOnly={statusIconOnly} fallback={<ThreadRowTime thread={thread} />} />} />}
      />
    </div>
  );
}

function ThreadRowMetaLine({ thread, presentation, chip, trailing }: Pick<ThreadRowVisualProps, "thread" | "presentation"> & { chip: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    // A scaffold row dims its content but never its status, so the dim skips the trailing slot.
    // The PR chip sits before the status so every row's status and actions end at the provider mark.
    <div data-testid="thread-line-branch" className="mt-0.5 flex h-4 min-w-0 items-center gap-1 text-caption text-muted">
      <div className={cn("flex min-w-0 flex-1 items-center gap-1", presentation.scaffoldDim)}>
        <ThreadModeIcon thread={thread} stale={presentation.isStaleWorktree} />
        <ThreadRowBranch thread={thread} stale={presentation.isStaleWorktree} />
      </div>
      {/* The chip renders nothing on a row with no PR; empty:hidden then drops its gap. */}
      <div className={cn("flex shrink-0 items-center pl-1 empty:hidden", presentation.scaffoldDim)}>{chip}</div>
      {trailing}
      <div className={cn("flex shrink-0 items-center pl-1", presentation.scaffoldDim)}>
        <ThreadRowProviderSlot provider={presentation.provider} providersUsed={thread.providers_used} className="opacity-(--provider-mark-opacity)" />
      </div>
    </div>
  );
}

function ClosedThreadRowBody(props: ThreadRowBodyProps) {
  const { thread, presentation, lifecycle } = props;
  return (
    <>
      {props.showProject && <ProjectIcon workspaceId={thread.workspace_id} name={props.workspaceName} size={16} tone="tinted" />}
      {props.isEditing
        ? <ThreadRowTitleInput {...props} />
        : (
          <ThreadTitleText title={thread.title} struck={false} className={cn("flex-1 text-label font-normal", props.isActive ? "text-ink" : "text-muted")} />
        )}
      {!props.isEditing && (
        <div className="relative flex shrink-0 items-center gap-1">
          <ClosedRowCleanupStatus presentation={presentation} lifecycle={lifecycle} />
          {presentation.cleanupBlocked && <ThreadCleanupRetry thread={thread} lifecycle={lifecycle} />}
          {/* No crossfade: a mid-fade frame draws "Restore" over the end of the title. */}
          <div style={props.revealed ? undefined : HIDDEN_ACTIONS} className="flex items-center gap-1">
            <ThreadLifecycleAction thread={thread} presentation={presentation} lifecycle={lifecycle} />
            <ThreadRowOptions {...props} />
          </div>
        </div>
      )}
    </>
  );
}

function ClosedRowCleanupStatus({ presentation, lifecycle }: Pick<ThreadRowVisualProps, "presentation" | "lifecycle">) {
  if (lifecycle.cleanupStatusLabel) return <CleanupRetryCaption lifecycle={lifecycle} />;
  if (presentation.cleanupBlocked) return <ThreadRowCaption className="text-status-label-error">Cleanup blocked</ThreadRowCaption>;
  return null;
}

type ThreadRowVariant = "flat" | "grouped" | "closed";

// Hover and focus restore full ink in CSS, not React state, so the change paints in the next frame.
const RECEDED_TITLE_CLASS = "text-ink/70 group-hover/row:text-ink group-focus-within/row:text-ink group-data-menu-open/row:text-ink";
const RECEDED_BADGE_CLASS = "opacity-55 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-menu-open/row:opacity-100";

const SURFACE_CLASS: Record<ThreadRowVariant, string> = {
  flat: "h-[78px] flex-col justify-center p-2",
  grouped: "h-[54px] flex-col justify-center py-2 pr-2",
  closed: "h-8 items-center gap-2 pr-2",
};


// The fill starts 18px in, after the line, so hover and selection never paint over it. Each row
// draws its own segment and an 8px-radius elbow into its title, so the line survives virtualization.
const TREE_LINE_CLASS = "ml-4.5 before:pointer-events-none before:absolute before:inset-y-0 before:-left-2 before:w-px before:bg-tree after:pointer-events-none after:absolute after:top-0 after:-left-2 after:w-2 after:rounded-bl-[8px] after:border-b after:border-l after:border-tree";
const TREE_ELBOW_CLASS: Record<Exclude<ThreadRowVariant, "flat">, string> = { grouped: "after:h-4.5", closed: "after:h-4" };

/** A Projects view row's segment of its project's thread line, curving into a one-line title. */
export function groupedTreeLineClass(treeLine: ThreadTreeLine): string | undefined {
  return treeLine === "none" ? undefined : cn(TREE_LINE_CLASS, TREE_ELBOW_CLASS.grouped, treeLine === "end" && "before:hidden");
}

function treeLineClass(variant: ThreadRowVariant, treeLine: ThreadTreeLine): string | undefined {
  if (treeLine === "none" || variant === "flat") return undefined;
  return cn(TREE_LINE_CLASS, TREE_ELBOW_CLASS[variant], treeLine === "end" && "before:hidden");
}

function surfacePaddingLeft(variant: ThreadRowVariant, depth: number): CSSProperties | undefined {
  if (variant === "flat") return undefined;
  return { paddingLeft: `${8 + depth * 12}px` };
}

type ThreadRowSurfaceProps = Pick<
  ThreadRowVisualProps,
  "thread" | "depth" | "isActive" | "isEditing" | "onThreadClick" | "onThreadDoubleClick" | "onSelectThread" | "onThreadContextMenu"
> & ComponentPropsWithoutRef<"div"> & { variant: ThreadRowVariant; treeLine: ThreadTreeLine; children: React.ReactNode; onRevealChange: (revealed: boolean) => void };

const ThreadRowSurface = forwardRef<HTMLDivElement, ThreadRowSurfaceProps>(function ThreadRowSurface({
  thread,
  depth,
  variant,
  treeLine,
  isActive,
  isEditing,
  onThreadClick,
  onThreadDoubleClick,
  onSelectThread,
  onThreadContextMenu,
  children,
  onRevealChange,
  className: triggerClassName,
  onMouseEnter: onTriggerMouseEnter,
  onMouseLeave: onTriggerMouseLeave,
  onFocus: onTriggerFocus,
  onBlur: onTriggerBlur,
  ...triggerProps
}, ref) {
  // The pointer leaves the row to reach its menu, so the open menu keeps the row's hover look
  // and the user can see which thread the menu acts on.
  const menuOpen = useThreadMenuOpenFor(thread.id);
  return (
    <div
      {...HOVER_ROW_PROPS}
      {...triggerProps}
      ref={ref}
      data-menu-open={menuOpen ? "" : undefined}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => handleThreadRowKeyDown(event, isEditing, onSelectThread, thread.id)}
      onClick={() => onThreadClick(thread.id)}
      onPointerDown={(event) => prefetchThreadRowOnPointerDown(event, isEditing, thread)}
      onDoubleClick={() => onThreadDoubleClick(thread.id)}
      onContextMenu={(event) => onThreadContextMenu(event, thread)}
      onMouseEnter={(event) => {
        scheduleThreadRowPrefetch(thread);
        onRevealChange(true);
        onTriggerMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        cancelPrefetch();
        onRevealChange(false);
        onTriggerMouseLeave?.(event);
      }}
      onFocus={(event) => {
        onRevealChange(true);
        onTriggerFocus?.(event);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onRevealChange(false);
        onTriggerBlur?.(event);
      }}
      className={cn(
        "group/row relative flex rounded-lg cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-focus/70",
        SURFACE_CLASS[variant],
        treeLineClass(variant, treeLine),
        isActive && "bg-selected",
        triggerClassName,
      )}
      style={surfacePaddingLeft(variant, depth)}
    >
      {children}
    </div>
  );
});

function handleThreadRowKeyDown(
  event: React.KeyboardEvent,
  isEditing: boolean,
  onSelectThread: (id: string) => void,
  threadId: string,
) {
  if (isEditing) return;
  if (event.key === "ArrowRight" && event.target === event.currentTarget) {
    focusRowPullRequestChip(event);
    return;
  }
  if (!isThreadRowNavigationEvent(event)) return;
  event.preventDefault();
  onSelectThread(threadId);
}

function focusRowPullRequestChip(event: React.KeyboardEvent): void {
  const chip = event.currentTarget.querySelector<HTMLElement>(`[aria-haspopup="menu"][data-testid^="thread-pr-indicator-"]`);
  if (!chip) return;
  event.preventDefault();
  chip.focus();
}

/** Enter or Space pressed on the row itself, not on a control inside it. */
export function isThreadRowNavigationEvent(event: React.KeyboardEvent): boolean {
  return (event.key === "Enter" || event.key === " ") && event.target === event.currentTarget;
}

function prefetchThreadRowOnPointerDown(
  event: React.PointerEvent,
  isEditing: boolean,
  thread: WorkspaceThread,
) {
  if (event.button !== 0 || isEditing || thread.clientPreparing || thread.clientError) return;
  prefetchOnPointerDown(thread.id);
}

function scheduleThreadRowPrefetch(thread: WorkspaceThread) {
  if (thread.clientPreparing || thread.clientError) return;
  schedulePrefetch(thread.id);
}

/** The provider that ran the thread before `current`, or null when the thread never switched. */
function previousProvider(current: string, providersUsed: readonly string[] | null | undefined): string | null {
  if (!providersUsed || providersUsed.length < 2) return null;
  return [...providersUsed].reverse().find((provider) => provider !== current) ?? null;
}

function ThreadRowProviderSlot({ provider, providersUsed, className }: { provider: string; providersUsed: readonly string[] | null | undefined; className?: string }) {
  const previous = previousProvider(provider, providersUsed);
  const label = previous && providersUsed
    ? `Providers, ${[provider, ...providersUsed.filter((used) => used !== provider).reverse()].map(providerLabel).join(", ")}`
    : `Provider, ${providerLabel(provider)}`;
  return (
    <div aria-label={label} className={cn("flex h-5 w-4 shrink-0 items-center justify-center", className)}>
      {previous ? <ProviderIconStack current={provider} previous={previous} /> : <ProviderIcon provider={provider} size={12} />}
    </div>
  );
}

type ThreadRowTitleProps = Pick<ThreadRowVisualProps, "thread" | "isEditing" | "inlineEdit" | "hasDraft" | "presentation" | "onInlineEditChange" | "onInlineEditCommit" | "onInlineEditCancel">;

/**
 * Splits a title that ends in a parenthetical, such as "Fix login (continued)", into the words
 * before it and that ending, or returns null when the title has no such ending.
 */
export function splitTitleEnding(title: string): { readonly head: string; readonly ending: string } | null {
  const match = /^(.*\S)\s+(\([^()]*\))$/.exec(title);
  return match?.[1] && match[2] ? { head: match[1], ending: match[2] } : null;
}

function StruckText({ struck, children }: { struck: boolean; children: string }) {
  return struck ? <span data-strike className="sidebar-strike">{children}</span> : <>{children}</>;
}

/**
 * A row title. A parenthetical ending stays visible and the words before it fade first; the head
 * shrinks far faster, so only an ending wider than the whole title space fades too.
 */
function ThreadTitleText({ title, struck, className }: { title: string; struck: boolean; className: string }) {
  const parts = splitTitleEnding(title);
  if (!parts) {
    return <div data-testid="thread-title" className={cn("text-fade min-w-0", className)}><StruckText struck={struck}>{title}</StruckText></div>;
  }
  return (
    <div data-testid="thread-title" className={cn("flex min-w-0 whitespace-pre", className)}>
      <span data-testid="thread-title-head" className="text-fade shrink-[1000]"><StruckText struck={struck}>{parts.head}</StruckText></span>
      <span data-testid="thread-title-ending" className="text-fade"> <StruckText struck={struck}>{parts.ending}</StruckText></span>
    </div>
  );
}

function ThreadRowTitleLine({
  className,
  children,
  iconOnlyDraft = false,
  ...props
}: ThreadRowTitleProps & { className?: string; children?: React.ReactNode; iconOnlyDraft?: boolean }) {
  const { presentation, thread } = props;
  return (
    <div data-title-line data-testid="thread-line-title" className={cn("flex h-5 min-w-0 items-center gap-2", className)}>
      {/* A scaffold row dims what it is, never its status: the status is the part that is live. */}
      <div className={cn("flex min-w-0 flex-1 items-center gap-2", presentation.scaffoldDim)}>
        {props.hasDraft && !props.isEditing && <DraftTag iconOnly={iconOnlyDraft} />}
        {props.isEditing ? (
          <ThreadRowTitleInput {...props} />
        ) : (
          <ThreadTitleText
            title={thread.title}
            struck={presentation.completing}
            className={cn(
              "flex-1 text-label",
              // A closing row lingers while hovered or focused, so the receded hover ink must not cover its fade.
              presentation.completing ? "text-muted/55" : presentation.titleTone === "prominent" ? "text-ink" : RECEDED_TITLE_CLASS,
            )}
          />
        )}
      </div>
      {children}
    </div>
  );
}

function ThreadRowTitleInput({ inlineEdit, onInlineEditChange, onInlineEditCommit, onInlineEditCancel }: Pick<ThreadRowVisualProps, "inlineEdit" | "onInlineEditChange" | "onInlineEditCommit" | "onInlineEditCancel">) {
  return (
    <Input
      type="text"
      size="compact"
      value={inlineEdit?.title ?? ""}
      onChange={(event) => onInlineEditChange(event.target.value)}
      onKeyDown={(event) => handleInlineEditKeyDown(event, onInlineEditCommit, onInlineEditCancel)}
      onBlur={onInlineEditCancel}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      className="-mx-1 h-5 flex-1 rounded-sm px-1 text-label border-focus hover:border-focus focus-visible:outline-0"
    />
  );
}

function handleInlineEditKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
  onCommit: () => void,
  onCancel: () => void,
) {
  if (!event.nativeEvent.isComposing && event.key === "Enter") onCommit();
  if (!event.nativeEvent.isComposing && event.key === "Escape") onCancel();
  event.stopPropagation();
}

function ThreadRowBranch({ thread, stale }: { thread: WorkspaceThread; stale: boolean }) {
  const checkoutLabel = resolveThreadCheckoutLabel(thread);
  return (
    <div
      aria-label={`Branch, ${checkoutLabel}`}
      className={cn("text-fade min-w-0 flex-1 font-mono", stale && "text-status-label-error line-through")}
    >
      {checkoutLabel}
    </div>
  );
}

function ThreadRowTime({ thread }: { thread: WorkspaceThread }) {
  const age = useRelativeTime(threadActivityAt(thread));
  if (reactProfilingEnabled) window.__mcodeReactPerformanceSink?.recordRowRender(`sidebar-age:${thread.id}`);
  return <div className="text-caption tabular-nums text-muted">{age}</div>;
}

// A completed row ages from its completion; an open one from its last turn, not from metadata writes.
function threadActivityAt(thread: WorkspaceThread): string {
  return thread.user_completed_at ?? thread.last_activity_at ?? thread.created_at;
}

/** Leads the branch line, so the checkout mode (worktree or local) takes the place of a branch glyph. */
function ThreadModeIcon({ thread, stale }: { thread: WorkspaceThread; stale: boolean }) {
  const isWorktree = thread.mode === "worktree";
  const label = isWorktree ? "Worktree" : "Local";
  return (
    <Tooltip>
      <TooltipTrigger render={
        <div
          aria-label={`${label} mode`}
          data-testid={isWorktree ? `thread-worktree-indicator-${thread.id}` : undefined}
          className={cn("flex h-4 w-4 shrink-0 items-center justify-center", stale && "text-status-label-error")}
        >
          {isWorktree ? <WorktreeModeIcon size={12} aria-hidden /> : <Laptop size={12} aria-hidden />}
        </div>
      } />
      <TooltipContent side="right" className="text-xs">{stale ? "Worktree directory no longer exists" : label}</TooltipContent>
    </Tooltip>
  );
}

// Hidden layers stay in the accessibility tree and the tab order; only the eye loses them.
const HIDDEN_LAYER: CSSProperties = { opacity: 0, pointerEvents: "none" };
const HIDDEN_ACTIONS: CSSProperties = { ...HIDDEN_LAYER, position: "absolute", insetInlineEnd: 0 };

/**
 * The row corner says one thing: actions under the pointer or focus, else the status. Hidden
 * actions take no width, so an idle line fades at the row edge instead of short of an empty gap.
 * A running row offers no Close, so its status stays and only the options button joins it.
 * When Close shows, the status keeps its icon ahead of the actions so the row keeps its meaning;
 * a corner that only shows a time gives way entirely. The swap paints in one frame with no
 * crossfade, because a mid-fade frame would draw "Close" over the status label.
 */
function ThreadRowTrailingSlot({ status, ...props }: ThreadRowBodyProps & { status: React.ReactNode }) {
  const { isEditing, lifecycle, revealed } = props;
  // At 220px a hovered row with a PR chip needs about 209px on a 173px meta line, so the worded
  // Close pushed the options button and provider mark past the row edge.
  const narrow = useSidebarNarrow();
  if (isEditing) return null;
  const swapped = revealed && !lifecycle.closeHidden;
  const swappedLook = swapped ? statusLook(props.presentation) : null;
  return (
    <div className="relative flex max-w-[55%] shrink-0 items-center gap-1">
      <div data-testid="thread-status" className="flex min-w-0 max-w-full items-center gap-1 empty:hidden">
        {swapped ? (swappedLook && <ThreadRowLookStatus look={swappedLook} iconOnly />) : status}
      </div>
      <div style={revealed ? undefined : HIDDEN_ACTIONS} className="flex items-center gap-1"><ThreadRowActions {...props} iconOnlyLifecycle={narrow} /></div>
    </div>
  );
}

/** The status look a row shows, or null when it shows a caption or nothing. A failed close reads as a caption. */
function statusLook(presentation: ThreadRowPresentation): ThreadStatusLook | null {
  if (presentation.completionFailure !== null) return null;
  return (presentation.completing ? THREAD_STATUS_LOOK.Closed : presentation.look) ?? null;
}

function ThreadRowStatus({ thread, presentation, lifecycle, fallback, iconOnly = false }: Pick<ThreadRowVisualProps, "thread" | "presentation" | "lifecycle"> & { fallback: React.ReactNode; iconOnly?: boolean }) {
  if (presentation.completionFailure !== null) {
    return <ThreadRowCaption role="status" className="text-status-label-error">{presentation.completionFailure}</ThreadRowCaption>;
  }
  const look = statusLook(presentation);
  if (!look) {
    return hasStandingCaption(presentation, lifecycle)
      ? <ThreadRowStandingCaption thread={thread} presentation={presentation} lifecycle={lifecycle} />
      : fallback;
  }
  return <ThreadRowLookStatus look={look} iconOnly={iconOnly} />;
}

/**
 * Icon then label in the icon's colour; the icon carries the name, so the label is hidden from
 * assistive tech. `iconOnly` drops the label and names the icon in the shared tooltip.
 */
function ThreadRowLookStatus({ look, iconOnly = false }: { look: ThreadStatusLook; iconOnly?: boolean }) {
  if (iconOnly) return <IconOnlyStatus look={look} />;
  return (
    <>
      <StatusMark state={look.state} label={look.label} icon={look.icon} />
      <ThreadRowCaption aria-hidden className={cn("font-medium", STATUS_LABEL_TEXT_CLASS[look.state])}>{look.label}</ThreadRowCaption>
    </>
  );
}

function hasStandingCaption(presentation: ThreadRowPresentation, lifecycle: ThreadRowLifecycleActions): boolean {
  return lifecycle.cleanupStatusLabel !== null || presentation.cleanupBlocked || presentation.isStaleWorktree || presentation.unusable;
}

function ThreadRowStandingCaption({ thread, presentation, lifecycle }: Pick<ThreadRowVisualProps, "thread" | "presentation" | "lifecycle">) {
  // A retry in flight or its failure is newer news than the standing block it retries.
  if (lifecycle.cleanupStatusLabel) return <CleanupRetryCaption lifecycle={lifecycle} />;
  if (presentation.cleanupBlocked) return <ThreadRowCaption className="text-status-label-error">Cleanup blocked</ThreadRowCaption>;
  if (presentation.isStaleWorktree) return <ThreadRowCaption className="text-status-label-error">Worktree unavailable</ThreadRowCaption>;
  if (presentation.unusable) {
    return <ThreadRowCaption className="text-status-label-error" data-testid={`sidebar-unusable-${thread.id}`}>{presentation.unusableReason}</ThreadRowCaption>;
  }
  return null;
}

function CleanupRetryCaption({ lifecycle }: Pick<ThreadRowVisualProps, "lifecycle">) {
  return (
    <ThreadRowCaption role="status" className={lifecycle.cleanupRetryFailed ? "text-status-label-error" : "text-muted"}>
      {lifecycle.cleanupRetryFailed ? null : <Spinner size={12} />}
      <span className="text-fade min-w-0">{lifecycle.cleanupStatusLabel}</span>
    </ThreadRowCaption>
  );
}

function ThreadRowCaption({ className, children, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div {...props} className={cn("text-fade flex min-w-0 items-center gap-1.5 whitespace-nowrap text-caption", className)}>
      {children}
    </div>
  );
}

function ThreadRowActions({ iconOnlyLifecycle = false, ...props }: Pick<ThreadRowVisualProps, "thread" | "presentation" | "lifecycle" | "threadMenuActions" | "workspacePath"> & { iconOnlyLifecycle?: boolean }) {
  const { thread, presentation, lifecycle } = props;
  return (
    <>
      {presentation.cleanupBlocked ? <ThreadCleanupRetry thread={thread} lifecycle={lifecycle} /> : null}
      {lifecycle.closeHidden ? null : <ThreadLifecycleAction thread={thread} presentation={presentation} lifecycle={lifecycle} iconOnly={iconOnlyLifecycle} />}
      <ThreadRowOptions {...props} />
    </>
  );
}

function ThreadRowOptions({ thread, threadMenuActions, workspacePath }: Pick<ThreadRowVisualProps, "thread" | "threadMenuActions" | "workspacePath">) {
  const target = { threadId: thread.id, threadTitle: thread.title, workspacePath, worktreePath: thread.worktree_path };
  return (
    <ThreadOptionsMenu
      target={target}
      actions={threadMenuActions}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-compact"
          aria-label={`Thread options for ${thread.title}`}
          // Only click and double-click stop here, so the row neither selects nor renames. Key and
          // pointer events must reach the document, where Base UI dismisses open menus.
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className={THREAD_ROW_ACTION_CLASS}
        >
          <MoreIcon size={14} />
        </Button>
      }
    />
  );
}

const LIFECYCLE_ACTION: Record<ThreadLifecycleKind, { readonly verb: string; readonly text: string }> = {
  complete: { verb: "Close", text: "Close" },
  undo: { verb: "Undo closing", text: "Undo" },
  retry: { verb: "Retry closing", text: "Retry" },
  reopen: { verb: "Restore", text: "Restore" },
};

/** Keeps the button's own Enter and Space inside it; Escape and every other key still reach the document. */
function stopActivationKeys(event: React.KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

/** `iconOnly` drops the word and names the action in the shared label tooltip, as narrow statuses do. */
function ThreadLifecycleAction({ thread, presentation, lifecycle, iconOnly = false }: Pick<ThreadRowVisualProps, "thread" | "presentation" | "lifecycle"> & { iconOnly?: boolean }) {
  const kind = presentation.lifecycleKind;
  const button = (
    <Button
      type="button"
      variant="ghost"
      size={iconOnly ? "icon-compact" : "compact"}
      aria-label={`${LIFECYCLE_ACTION[kind].verb} ${thread.title}`}
      disabled={kind !== "undo" && lifecycle.lifecycleUnavailable}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={stopActivationKeys}
      onClick={(event) => {
        event.stopPropagation();
        void lifecycle.handleLifecycleClick(event);
      }}
      className={cn("shrink-0 gap-1 rounded-md text-caption font-medium text-ink shadow-none disabled:cursor-not-allowed", iconOnly ? "size-5 p-0" : "h-6 px-1")}
    >
      <ThreadLifecycleIcon isPending={lifecycle.isLifecyclePending} kind={kind} />
      {iconOnly ? null : LIFECYCLE_ACTION[kind].text}
    </Button>
  );
  return iconOnly ? <SidebarLabelTrigger label={LIFECYCLE_ACTION[kind].text}>{button}</SidebarLabelTrigger> : button;
}

function ThreadLifecycleIcon({ isPending, kind }: { isPending: boolean; kind: ThreadLifecycleKind }) {
  if (isPending) return <Spinner size={12} />;
  if (kind === "retry") return <RefreshCw size={13} aria-hidden />;
  if (kind === "complete") return <Archive size={14} aria-hidden />;
  if (kind === "reopen") return <ArchiveRestore size={14} aria-hidden />;
  return <Undo2 size={14} aria-hidden />;
}

function ThreadCleanupRetry({ thread, lifecycle }: Pick<ThreadRowVisualProps, "thread" | "lifecycle">) {
  return (
    <ThreadRowAction
      label={`Retry cleanup for ${thread.title}`}
      tooltip="Retry cleanup"
      disabled={lifecycle.isCleanupRetryPending}
      onClick={lifecycle.handleCleanupRetry}
    >
      {lifecycle.isCleanupRetryPending ? <Spinner size={12} /> : <RefreshCw size={13} aria-hidden />}
    </ThreadRowAction>
  );
}

const THREAD_ROW_ACTION_CLASS = "size-5 shrink-0 rounded-md p-0 text-muted shadow-none hover:bg-transparent hover:text-ink disabled:cursor-not-allowed";

function ThreadRowAction({
  label,
  tooltip,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  disabled?: boolean;
  onClick: (event: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          type="button"
          variant="ghost"
          size="icon-compact"
          aria-label={label}
          disabled={disabled}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClick(event);
          }}
          className={THREAD_ROW_ACTION_CLASS}
        >
          {children}
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ThreadRowPreview({
  isEditing,
  row,
  workspaceName,
  thread,
}: { isEditing: boolean; row: React.ReactElement<React.HTMLAttributes<HTMLElement>>; workspaceName: string; thread: WorkspaceThread }) {
  const handle = useContext(ThreadPreviewHandleContext);
  const payload = useMemo(() => ({ thread, workspaceName }), [thread, workspaceName]);
  if (isEditing || !handle) return row;
  return (
    <TooltipTrigger
      handle={handle}
      payload={payload}
      render={(props, state) => cloneElement(row, mergeProps(row.props, props, { "aria-describedby": state.open ? THREAD_PREVIEW_ID : undefined }))}
    />
  );
}
