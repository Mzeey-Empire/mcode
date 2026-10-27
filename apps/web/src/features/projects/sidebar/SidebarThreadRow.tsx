import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, type ComponentPropsWithoutRef } from "react";
import { Check, GitBranch, Laptop, RefreshCw, Undo2 } from "lucide-react";
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
import { ThreadStatusLane } from "@/features/thread-attention/ThreadStatusLane";
import { threadRowLook, threadTitleTone, useThreadRowState, type ThreadRowLook, type ThreadTitleTone } from "@/features/thread-attention/thread-row-presentation";
import type { ThreadRowState } from "@/features/thread-attention/thread-row-state";
import { getPrVisual } from "@/lib/pr-status";
import { isPrable } from "@/lib/is-prable";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import type { Thread, Workspace } from "@/transport/types";
import { useWorkspaceStore } from "../state/workspaceStore";
import { selectThreadIndex } from "../state/thread-index";
import { IDLE_CLEANUP_RETRY, useRowLifecycleStore } from "./row-lifecycle-store";
import type { SidebarItem } from "./sidebar-model";
import type { InlineEditState, SidebarProviderAvailability, SidebarRowContext } from "./sidebar-row-context";

type ThreadItem = Extract<SidebarItem, { kind: "thread" }>;

interface ThreadRowHandlers {
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onThreadClick: (threadId: string) => void;
  onThreadDoubleClick: (threadId: string) => void;
  onSelectThread: (id: string) => void;
  onThreadContextMenu: (e: React.MouseEvent, thread: Thread) => void;
}

/**
 * One sidebar thread row. It reads its thread and project by id, so a push for another thread
 * never re-renders it.
 */
export const SidebarThreadRow = memo(function SidebarThreadRow({ item, ctx }: { item: ThreadItem; ctx: SidebarRowContext }) {
  const thread = useWorkspaceStore((s) => selectThreadIndex(s.threads).get(item.threadId));
  const workspace = useWorkspaceStore((s) => (thread ? s.workspaces.find((candidate) => candidate.id === thread.workspace_id) : undefined));
  if (!thread) return null;
  return <ThreadRow thread={thread} workspace={workspace} depth={item.depth} showProject={item.layout === "flat"} ctx={ctx} />;
});

function useThreadRowHandlers(ctx: SidebarRowContext, workspaceId: string, workspacePath: string): ThreadRowHandlers {
  return useMemo(() => ({
    onInlineEditChange: ctx.onInlineEditChange,
    onInlineEditCommit: ctx.onInlineEditCommit,
    onInlineEditCancel: ctx.onInlineEditCancel,
    onThreadClick: (threadId: string) => ctx.onThreadClick(workspaceId, threadId),
    onThreadDoubleClick: ctx.onThreadDoubleClick,
    onSelectThread: (threadId: string) => ctx.onSelectThread(workspaceId, threadId),
    onThreadContextMenu: (event: React.MouseEvent, clicked: Thread) => ctx.onThreadContextMenu(event, clicked, workspacePath),
  }), [ctx, workspaceId, workspacePath]);
}

function ThreadRow({ thread, workspace, depth, showProject, ctx }: { thread: WorkspaceThread; workspace: Workspace | undefined; depth: number; showProject: boolean; ctx: SidebarRowContext }) {
  const isEditing = ctx.inlineEdit?.threadId === thread.id;
  const handlers = useThreadRowHandlers(ctx, thread.workspace_id, workspace?.path ?? "");
  const isActive = useWorkspaceStore((s) => s.activeThreadId === thread.id);
  const isRunning = useThreadStore((s) => isThreadExecuting(thread.id, s));
  const startupPending = useWorkspaceStore((s) => s.pendingStartupByThreadId[thread.id] !== undefined);
  const rowState = useThreadRowState(thread.id, thread.clientPreparing === true);
  const presentation = createThreadRowPresentation(thread, rowState, ctx, startupPending, isActive);
  const lifecycle = useThreadLifecycleActions({
    thread,
    isEditing,
    isRunning,
    awaitingApproval: rowState.kind === "needs-you" && rowState.label === "Approval required",
    startupPending,
    isUserCompleted: presentation.isUserCompleted,
    cleanupBlocked: presentation.cleanupBlocked,
    onCompleteThread: ctx.onCompleteThread,
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
      showProject={showProject}
      isEditing={isEditing}
      inlineEdit={isEditing ? ctx.inlineEdit : null}
      isActive={isActive}
      presentation={presentation}
      lifecycle={lifecycle}
    />
  );
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
  isUserCompleted: boolean;
  cleanupBlocked: boolean;
}

interface ThreadRowLifecycleActions {
  isLifecyclePending: boolean;
  isCleanupRetryPending: boolean;
  cleanupStatusLabel: string | null;
  cleanupRetryFailed: boolean;
  lifecycleUnavailable: boolean;
  handleLifecycleClick: (event: React.MouseEvent) => Promise<void>;
  handleCleanupRetry: (event: React.MouseEvent) => Promise<void>;
}

interface ThreadRowVisualProps {
  workspaceName: string;
  thread: WorkspaceThread;
  depth: number;
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
  isActive: boolean;
  presentation: ThreadRowPresentation;
  lifecycle: ThreadRowLifecycleActions;
}

function createThreadRowPresentation(
  thread: WorkspaceThread,
  rowState: ThreadRowState,
  ctx: Pick<SidebarRowContext, "worktreesLoadedFor" | "validWorktreePaths" | "availableProviders">,
  startupPending: boolean,
  isActive: boolean,
): ThreadRowPresentation {
  const isUserCompleted = thread.user_completed_at !== null;
  return {
    look: threadRowLook(rowState),
    titleTone: threadTitleTone(rowState, isActive),
    isStaleWorktree: hasStaleThreadWorktree(thread, ctx.worktreesLoadedFor, ctx.validWorktreePaths),
    ...threadProviderPresentation(thread.provider, ctx.availableProviders),
    scaffoldDim: thread.clientPreparing || thread.clientError || startupPending ? "opacity-[0.72]" : false,
    isUserCompleted,
    cleanupBlocked: isUserCompleted && thread.cleanup_state === "blocked",
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
  isUserCompleted,
  cleanupBlocked,
  onCompleteThread,
  onReopenThread,
  onRetryThreadCleanup,
}: Pick<SidebarRowContext, "onCompleteThread" | "onReopenThread" | "onRetryThreadCleanup"> & {
  thread: WorkspaceThread;
  isEditing: boolean;
  isRunning: boolean;
  awaitingApproval: boolean;
  startupPending: boolean;
  isUserCompleted: boolean;
  cleanupBlocked: boolean;
}): ThreadRowLifecycleActions {
  const isLifecyclePending = useRowLifecycleStore((state) => state.pendingLifecycle.has(thread.id));
  const cleanupRetry = useRowLifecycleStore((state) => state.cleanupRetry.get(thread.id) ?? IDLE_CLEANUP_RETRY);
  const isCleanupRetryPending = cleanupRetry.pending;
  const cleanupRetryError = cleanupRetry.error;
  const lifecycleUnavailable = isLifecyclePending
    || isEditing
    || isRunning
    || awaitingApproval
    || startupPending
    || Boolean(thread.clientPreparing || thread.clientError);
  const handleLifecycleClick = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    // Read the store directly: two clicks in one frame both pass the committed
    // snapshot before the subscribed re-render lands.
    const rowLifecycle = useRowLifecycleStore.getState();
    if (lifecycleUnavailable
      || rowLifecycle.pendingLifecycle.has(thread.id)
      || useWorkspaceStore.getState().pendingStartupByThreadId[thread.id] !== undefined) return;
    rowLifecycle.setLifecyclePending(thread.id, true);
    try {
      const updateLifecycle = isUserCompleted ? onReopenThread : onCompleteThread;
      await updateLifecycle(thread.id);
    } catch {
      // The store action already surfaces the failure via workspaceStore.error;
      // swallowing here keeps expected rejections (e.g. a pending mutation when
      // a turn raced the click) out of the unhandled-rejection crash reporter.
    } finally {
      useRowLifecycleStore.getState().setLifecyclePending(thread.id, false);
    }
  }, [isUserCompleted, lifecycleUnavailable, onCompleteThread, onReopenThread, thread.id]);
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
    handleLifecycleClick,
    handleCleanupRetry,
  };
}

function cleanupStatusLabel(retryError: string | null, cleanupState: WorkspaceThread["cleanup_state"]): string | null {
  if (retryError) return `Cleanup retry failed: ${retryError}`;
  if (cleanupState === "queued") return "Cleanup queued";
  if (cleanupState === "retrying") return "Retrying cleanup";
  return null;
}

function ThreadRowVisual({
  workspaceName,
  thread,
  depth,
  showProject,
  isEditing,
  inlineEdit,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  onThreadClick,
  onThreadDoubleClick,
  onSelectThread,
  onThreadContextMenu,
  isActive,
  presentation,
  lifecycle,
}: ThreadRowVisualProps) {
  const row = (
    <ThreadRowSurface
      thread={thread}
      depth={depth}
      isActive={isActive}
      isEditing={isEditing}
      onThreadClick={onThreadClick}
      onThreadDoubleClick={onThreadDoubleClick}
      onSelectThread={onSelectThread}
      onThreadContextMenu={onThreadContextMenu}
    >
      <ThreadStatusLane mark={presentation.look.mark} />
      <div className={cn("flex min-w-0 flex-1 flex-col gap-1", presentation.scaffoldDim)}>
        {showProject && <ThreadRowProjectLine workspaceId={thread.workspace_id} workspaceName={workspaceName} />}
        <ThreadRowTitleLine
          thread={thread}
          isEditing={isEditing}
          inlineEdit={inlineEdit}
          presentation={presentation}
          onInlineEditChange={onInlineEditChange}
          onInlineEditCommit={onInlineEditCommit}
          onInlineEditCancel={onInlineEditCancel}
        />
        <ThreadRowBranchLine thread={thread} presentation={presentation} />
        <ThreadRowThirdLine thread={thread} presentation={presentation} lifecycle={lifecycle} />
      </div>
      <ThreadRowActions
        thread={thread}
        isEditing={isEditing}
        presentation={presentation}
        lifecycle={lifecycle}
        onThreadContextMenu={onThreadContextMenu}
      />
    </ThreadRowSurface>
  );
  return <ThreadRowPreview isEditing={isEditing} row={row} workspaceName={workspaceName} thread={thread} />;
}

function ThreadRowProjectLine({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  return (
    <div className="flex h-4 min-w-0 items-center gap-1.5 text-caption text-muted">
      <ProjectIcon workspaceId={workspaceId} name={workspaceName} size={14} className="shrink-0" />
      <span className="text-fade min-w-0 flex-1">{workspaceName}</span>
    </div>
  );
}

type ThreadRowSurfaceProps = Pick<
  ThreadRowVisualProps,
  "thread" | "depth" | "isActive" | "isEditing" | "onThreadClick" | "onThreadDoubleClick" | "onSelectThread" | "onThreadContextMenu"
> & ComponentPropsWithoutRef<"div"> & { children: React.ReactNode };

const ThreadRowSurface = forwardRef<HTMLDivElement, ThreadRowSurfaceProps>(function ThreadRowSurface({
  thread,
  depth,
  isActive,
  isEditing,
  onThreadClick,
  onThreadDoubleClick,
  onSelectThread,
  onThreadContextMenu,
  children,
  className: triggerClassName,
  onMouseEnter: onTriggerMouseEnter,
  onMouseLeave: onTriggerMouseLeave,
  ...triggerProps
}, ref) {
  return (
    <div
      {...triggerProps}
      ref={ref}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => handleThreadRowKeyDown(event, isEditing, onSelectThread, thread.id)}
      onClick={() => onThreadClick(thread.id)}
      onPointerDown={(event) => prefetchThreadRowOnPointerDown(event, isEditing, thread)}
      onDoubleClick={() => onThreadDoubleClick(thread.id)}
      onContextMenu={(event) => onThreadContextMenu(event, thread)}
      onMouseEnter={(event) => {
        scheduleThreadRowPrefetch(thread);
        onTriggerMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        cancelPrefetch();
        onTriggerMouseLeave?.(event);
      }}
      className={cn(
        "group/row relative flex min-h-16 items-start gap-2 rounded-lg py-3 pr-2 cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus/70",
        "has-[[data-status-mark=running]]:opacity-55",
        isActive ? "bg-selected" : "hover:bg-selected/40",
        triggerClassName,
      )}
      style={{ paddingLeft: `${4 + depth * 12}px` }}
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
  if (isEditing || !isThreadRowNavigationEvent(event)) return;
  event.preventDefault();
  onSelectThread(threadId);
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

function ThreadRowProviderSlot({ provider, providersUsed, isUserCompleted }: { provider: string; providersUsed: readonly string[] | null | undefined; isUserCompleted: boolean }) {
  const previous = previousProvider(provider, providersUsed);
  const label = previous && providersUsed
    ? `Providers, ${[provider, ...providersUsed.filter((used) => used !== provider).reverse()].map(providerLabel).join(", ")}`
    : `Provider, ${providerLabel(provider)}`;
  return (
    <div
      aria-label={label}
      className={cn("flex h-5 w-4 shrink-0 items-center justify-center text-muted", isUserCompleted && "grayscale opacity-45")}
    >
      {previous ? <ProviderIconStack current={provider} previous={previous} /> : <ProviderIcon provider={provider} size={12} />}
    </div>
  );
}

function ThreadRowTitleLine({
  thread,
  isEditing,
  inlineEdit,
  presentation,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
}: Pick<ThreadRowVisualProps, "thread" | "isEditing" | "inlineEdit" | "presentation" | "onInlineEditChange" | "onInlineEditCommit" | "onInlineEditCancel">) {
  // The right padding keeps the title clear of the hover actions so it never reflows on hover.
  return (
    <div className={cn("flex h-5 min-w-0 items-center gap-2", !isEditing && "pr-[60px]")}>
      <ThreadRowProviderSlot provider={presentation.provider} providersUsed={thread.providers_used} isUserCompleted={presentation.isUserCompleted} />
      {isEditing ? (
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
          className="flex-1 border-focus"
        />
      ) : (
        <div
          className={cn(
            "text-fade min-w-0 flex-1 text-label",
            presentation.titleTone === "prominent" ? "text-ink" : "text-muted",
            presentation.isUserCompleted && "text-muted/55 line-through decoration-muted/55 decoration-1",
          )}
          data-testid="thread-title"
        >
          {thread.title}
        </div>
      )}
    </div>
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

function ThreadRowBranchLine({ thread, presentation }: Pick<ThreadRowVisualProps, "thread" | "presentation">) {
  const checkoutLabel = resolveThreadCheckoutLabel(thread);
  const stale = presentation.isStaleWorktree;
  return (
    <div className="flex h-4 min-w-0 items-center gap-2 text-caption text-muted">
      <ThreadModeIcon thread={thread} stale={stale} />
      <div
        aria-label={`Branch, ${checkoutLabel}`}
        className={cn("text-fade min-w-0 flex-1 font-mono", stale && "text-error line-through")}
      >
        {checkoutLabel}
      </div>
      <div className="w-6 shrink-0 text-right tabular-nums">{relativeTime(thread.updated_at)}</div>
    </div>
  );
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
          className={cn("flex h-4 w-4 shrink-0 items-center justify-center", stale && "text-error")}
        >
          {isWorktree ? <WorktreeModeIcon size={12} aria-hidden /> : <Laptop size={12} aria-hidden />}
        </div>
      } />
      <TooltipContent side="right" className="text-xs">{stale ? "Worktree directory no longer exists" : label}</TooltipContent>
    </Tooltip>
  );
}

/** The third line: a row state label when there is one, otherwise the most urgent thread context. */
function ThreadRowThirdLine({
  thread,
  presentation,
  lifecycle,
}: Pick<ThreadRowVisualProps, "thread" | "presentation" | "lifecycle">) {
  const label = presentation.look.label;
  if (label) return <ThreadRowCaption className={label.className}>{label.text}</ThreadRowCaption>;
  // A retry in flight or its failure is newer news than the standing block it retries.
  if (lifecycle.cleanupStatusLabel) {
    return (
      <ThreadRowCaption role="status" className={lifecycle.cleanupRetryFailed ? "text-error" : "text-muted"}>
        {lifecycle.cleanupRetryFailed ? null : <Spinner size={12} />}
        <span className="text-fade min-w-0">{lifecycle.cleanupStatusLabel}</span>
      </ThreadRowCaption>
    );
  }
  if (presentation.cleanupBlocked) return <ThreadRowCaption className="text-error">Cleanup blocked</ThreadRowCaption>;
  if (presentation.isStaleWorktree) return <ThreadRowCaption className="text-error">Worktree unavailable</ThreadRowCaption>;
  if (presentation.unusable) {
    return <ThreadRowCaption className="text-error" data-testid={`sidebar-unusable-${thread.id}`}>{presentation.unusableReason}</ThreadRowCaption>;
  }
  const primaryPr = rankPullRequests(thread.pull_requests)[0];
  if (isPrable(thread) && primaryPr) {
    return <ThreadPrLine threadId={thread.id} prNumber={primaryPr.number} prStatus={primaryPr.state} dimmed={presentation.isUserCompleted} />;
  }
  return null;
}

function ThreadRowCaption({ className, children, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div {...props} className={cn("flex h-4 min-w-0 items-center gap-1.5 text-caption", className)}>
      {children}
    </div>
  );
}

function ThreadRowActions({
  thread,
  isEditing,
  presentation,
  lifecycle,
  onThreadContextMenu,
}: Pick<ThreadRowVisualProps, "thread" | "isEditing" | "presentation" | "lifecycle" | "onThreadContextMenu">) {
  if (isEditing) return null;
  return (
    <div className="absolute right-2 top-3 flex h-5 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-within:opacity-100">
      {presentation.cleanupBlocked ? <ThreadCleanupRetry thread={thread} lifecycle={lifecycle} /> : null}
      <ThreadLifecycleAction thread={thread} presentation={presentation} lifecycle={lifecycle} />
      <ThreadRowAction
        label={`Thread options for ${thread.title}`}
        tooltip="More"
        onClick={(event) => onThreadContextMenu(event, thread)}
      >
        <MoreIcon size={14} />
      </ThreadRowAction>
    </div>
  );
}

function ThreadLifecycleAction({ thread, presentation, lifecycle }: Pick<ThreadRowVisualProps, "thread" | "presentation" | "lifecycle">) {
  const reopen = presentation.isUserCompleted;
  return (
    <ThreadRowAction
      label={reopen ? `Reopen ${thread.title}` : `Complete ${thread.title}`}
      tooltip={reopen ? "Undo completion" : "Complete thread"}
      disabled={lifecycle.lifecycleUnavailable}
      onClick={lifecycle.handleLifecycleClick}
    >
      <ThreadLifecycleIcon isPending={lifecycle.isLifecyclePending} reopen={reopen} />
    </ThreadRowAction>
  );
}

function ThreadLifecycleIcon({ isPending, reopen }: { isPending: boolean; reopen: boolean }) {
  if (isPending) return <Spinner size={12} />;
  if (reopen) return <Undo2 size={14} aria-hidden />;
  return <Check size={14} aria-hidden />;
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
          className="size-5 shrink-0 rounded-md p-0 text-muted shadow-none hover:bg-transparent hover:text-ink disabled:cursor-not-allowed"
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
}: { isEditing: boolean; row: React.ReactElement; workspaceName: string; thread: WorkspaceThread }) {
  if (isEditing) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent side="right" align="start" sideOffset={8} className="max-w-none p-3">
        <SidebarThreadPreview workspaceName={workspaceName} thread={thread} />
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarThreadPreview({
  workspaceName,
  thread,
}: {
  workspaceName: string;
  thread: WorkspaceThread;
}) {
  const checkoutLabel = resolveThreadCheckoutLabel(thread);

  return (
    <div
      data-testid={`thread-preview-${thread.id}`}
      className="w-64 space-y-2 text-ink"
    >
      <div className="min-w-0 font-medium text-xs leading-5">
        {thread.title}
      </div>
      <div className="grid gap-1.5">
        <div className="text-xs text-muted">
          Updated {formatLifecycleDate(thread.updated_at)}
        </div>
        {thread.user_completed_at !== null ? (
          <>
            <div className="text-xs text-muted">
              Completed {formatLifecycleDate(thread.user_completed_at)}
            </div>
            {thread.cleanup_state === "blocked" ? (
              <div className="text-xs text-destructive" role="status">
                Cleanup blocked: {thread.cleanup_reason ?? "User action is required."}
              </div>
            ) : thread.cleanup_state === "queued" ? (
              <div className="text-xs text-muted" role="status">
                Cleanup queued
              </div>
            ) : thread.cleanup_state === "retrying" ? (
              <div className="text-xs text-muted" role="status">
                Retrying cleanup
              </div>
            ) : (
              <div className="text-xs text-muted">
                {thread.scheduled_deletion_at
                  ? `Deletes ${formatLifecycleDate(thread.scheduled_deletion_at)}`
                  : "Automatic deletion disabled"}
              </div>
            )}
          </>
        ) : null}
        <div
          aria-label={`Project, ${workspaceName}`}
          className="flex min-w-0 items-center gap-2"
        >
          <ProjectIcon workspaceId={thread.workspace_id} name={workspaceName} size={14} />
          <span className="text-fade text-xs">{workspaceName}</span>
        </div>
        <div
          aria-label={`Branch, ${checkoutLabel}`}
          className="flex min-w-0 items-center gap-2"
        >
          <GitBranch size={13} aria-hidden className="shrink-0 opacity-75" />
          <span className="text-fade font-mono text-xs">{checkoutLabel}</span>
        </div>
      </div>
    </div>
  );
}

function formatLifecycleDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

/** The PR context line: the PR icon and number, tinted by PR state. */
function ThreadPrLine({
  threadId,
  prNumber,
  prStatus,
  dimmed,
}: {
  threadId: string;
  prNumber: number;
  prStatus: string | null;
  dimmed: boolean;
}) {
  const { Icon: PrIcon, color: prColor } = getPrVisual(prStatus);
  return (
    <div
      aria-label={`PR #${prNumber}, ${prStatus ?? "open"}`}
      data-testid={`thread-pr-indicator-${threadId}`}
      className={cn("flex h-5 min-w-0 items-center gap-1 text-caption text-muted", dimmed && "grayscale opacity-45")}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <PrIcon size={16} aria-hidden className={prColor} />
      </span>
      <span className={cn("shrink-0 font-medium underline underline-offset-2", prColor)}>PR #{prNumber}</span>
    </div>
  );
}
