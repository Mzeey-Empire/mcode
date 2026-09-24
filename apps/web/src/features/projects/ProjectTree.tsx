import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useRef,
  useMemo,
  useSyncExternalStore,
  memo,
  forwardRef,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ReactNode,
} from "react";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useThreadDraftStore, type ThreadDraft } from "@/stores/threadDraftStore";
import { hasRecoveryEntry, useRecoveryIncidentStore } from "@/features/recovery/state/recoveryIncidentStore";
import { useUiStore } from "@/stores/uiStore";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import {
  Trash2,
  GitBranch,
  GitBranchMinus,
  AlertTriangle,
  ChevronRight,
  FolderPlus,
  Folder,
  FolderCheck,
  FolderOpen,
  Activity,
  MoreHorizontal,
  Pencil,
  Plus,
  SquarePen,
  Circle,
  Check,
  RefreshCw,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";
import {
  ClaudeIcon,
  CodexIcon,
  CopilotIcon,
  CursorProviderIcon,
  DevinIcon,
  GeminiIcon,
  OpenCodeIcon,
} from "@/components/chat/ProviderIcons";
import { getPrVisual } from "@/lib/pr-status";
import { formatRelative } from "@/lib/format-relative";
import { cn } from "@/lib/utils";
import { VirtualRows } from "@/components/ui/VirtualRows";
import {
  VirtualViewport,
  type VirtualHost,
  type ViewportPosition,
} from "@/components/ui/virtual-viewport";
import { ContextMenu } from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  schedulePrefetch,
  cancelPrefetch,
  prefetchOnPointerDown,
} from "@/features/conversation";
import { isPrable } from "@/lib/is-prable";
import { getCiVisual, CI_ICON_STROKE } from "@/lib/ci-status";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { FILE_EXPLORER_ID } from "@/lib/resolveDefaultOpenInApp";
import { getTransport } from "@/transport";
import { useToastStore } from "@/stores/toastStore";
import type { ChecksStatus } from "@mcode/contracts";
import type { Workspace, Thread } from "@/transport/types";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { getThreadStateMarker, ThreadStateMarker } from "@/components/sidebar/ThreadStateMarker";
import { useProjectAutomaticSetup } from "@/features/projects/environment";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  closestCenter,
  type CollisionDetection,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";

// Persist expand/collapse in localStorage
function getExpandedState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("mcode-expanded-projects") || "{}");
  } catch {
    return {};
  }
}

function setExpandedState(state: Record<string, boolean>) {
  localStorage.setItem("mcode-expanded-projects", JSON.stringify(state));
}

/** Maximum threads shown per workspace before "Show more" appears. */
const THREAD_LIST_CAP = 6;

/** Stable empty array used as default when a workspace has no threads. */
const EMPTY_THREADS: WorkspaceThread[] = [];
const EMPTY_DRAFTS: readonly ThreadDraft[] = [];

const PROJECT_DND_MODIFIERS = [restrictToVerticalAxis];
// The virtual list mounts project droppables only near the viewport, so they
// must be measured as they register rather than once before the drag starts.
// Rows never displace during a project drag; the indicator line marks the
// landing boundary instead, so an expanded group's height cannot bias the
// drop target.
const STATIC_SORT_STRATEGY = () => null;

// pointerInside a group wins; in the padding gaps or the empty space beyond
// the list the pointer belongs to the vertically nearest group edge, so a
// drop there still lands instead of silently cancelling.
const projectTreeCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length > 0) return within;
  const { pointerCoordinates, droppableRects, droppableContainers } = args;
  if (!pointerCoordinates) return closestCenter(args);
  let nearest: (typeof droppableContainers)[number] | undefined;
  let nearestDistance = Infinity;
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const distance =
      pointerCoordinates.y < rect.top
        ? rect.top - pointerCoordinates.y
        : pointerCoordinates.y > rect.bottom
          ? pointerCoordinates.y - rect.bottom
          : 0;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = container;
    }
  }
  return nearest
    ? [
        {
          id: nearest.id,
          data: { droppableContainer: nearest, value: nearestDistance },
        },
      ]
    : [];
};

const PROJECT_DND_MEASURING = {
  droppable: {
    strategy: MeasuringStrategy.Always,
  },
} as const;

/** Time window in ms during which a second click on the same thread row is treated as a double-click. */
const DOUBLE_CLICK_THRESHOLD_MS = 250;

/** Read per-workspace "show all threads" state from localStorage. */
function getThreadListExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(
      localStorage.getItem("mcode-expanded-thread-lists") || "{}",
    );
  } catch {
    return {};
  }
}

/** Persist per-workspace "show all threads" state to localStorage. */
function setThreadListExpanded(state: Record<string, boolean>) {
  localStorage.setItem("mcode-expanded-thread-lists", JSON.stringify(state));
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT"
    || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT"
    || target.isContentEditable
    || target.closest('[contenteditable="true"]') !== null
    || target.getAttribute("role") === "textbox"
    || target.hasAttribute("aria-multiline");
}

function activeThreadForRename(
  event: KeyboardEvent,
  activeThreadId: string | null,
  inlineEdit: InlineEditState | null,
  threads: WorkspaceThread[],
): WorkspaceThread | undefined {
  if (event.key !== "F2" || !activeThreadId || inlineEdit) return undefined;
  if (isEditableKeyboardTarget(event.target)) return undefined;
  return threads.find((thread) => thread.id === activeThreadId);
}

function ThreadContextMenuOverlay({
  contextMenu,
  onClose,
  onStartRename,
  onDeleteThread,
}: {
  contextMenu: ContextMenuState | null;
  onClose: () => void;
  onStartRename: (state: InlineEditState) => void;
  onDeleteThread: (state: DeleteDialogState) => void;
}) {
  if (!contextMenu) return null;
  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      onClose={onClose}
      items={[
        {
          label: "Rename",
          onClick: () => onStartRename({
            threadId: contextMenu.threadId,
            title: contextMenu.threadTitle,
            originalTitle: contextMenu.threadTitle,
          }),
        },
        {
          label: "Copy Path",
          onClick: () => navigator.clipboard.writeText(
            contextMenu.worktreePath ?? contextMenu.workspacePath,
          ),
        },
        {
          label: "Copy Thread ID",
          onClick: () => navigator.clipboard.writeText(contextMenu.threadId),
        },
        { label: "", onClick: () => {}, divider: true },
        {
          label: "Delete",
          destructive: true,
          onClick: () => onDeleteThread({
            threadId: contextMenu.threadId,
            threadTitle: contextMenu.threadTitle,
            worktreePath: contextMenu.worktreePath,
          }),
        },
      ]}
    />
  );
}

function DraftContextMenuOverlay({
  contextMenu,
  onClose,
  onDeleteDraft,
}: {
  contextMenu: DraftContextMenuState | null;
  onClose: () => void;
  onDeleteDraft: (draftId: string) => void;
}) {
  if (!contextMenu) return null;
  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      onClose={onClose}
      items={[
        {
          label: "Delete draft",
          destructive: true,
          onClick: () => onDeleteDraft(contextMenu.draftId),
        },
      ]}
    />
  );
}

function ThreadDeleteDialog({
  dialog,
  deleteWorktree,
  isDeleting,
  onDeleteWorktreeChange,
  onClose,
  onConfirm,
}: {
  dialog: DeleteDialogState | null;
  deleteWorktree: boolean;
  isDeleting: boolean;
  onDeleteWorktreeChange: (value: boolean) => void;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !isDeleting) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md overflow-hidden">
        <div className="flex flex-col gap-2">
          <DialogTitle>Delete thread</DialogTitle>
          <DialogDescription>Are you sure you want to delete &ldquo;{dialog?.threadTitle}&rdquo;? This action cannot be undone.</DialogDescription>
        </div>
        <ThreadDeleteWorktreeOption dialog={dialog} deleteWorktree={deleteWorktree} isDeleting={isDeleting} onChange={onDeleteWorktreeChange} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" className="cursor-pointer" disabled={isDeleting} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" className="cursor-pointer" disabled={isDeleting} onClick={onConfirm}>
            {isDeleting && <Spinner size={14} className="text-current" />}
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ThreadDeleteWorktreeOption({
  dialog,
  deleteWorktree,
  isDeleting,
  onChange,
}: {
  dialog: DeleteDialogState | null;
  deleteWorktree: boolean;
  isDeleting: boolean;
  onChange: (value: boolean) => void;
}) {
  if (!dialog?.worktreePath) return null;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border p-3">
      <GitBranch size={14} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Delete worktree</div>
        <div className="truncate text-xs text-muted-foreground">{dialog.worktreePath}</div>
      </div>
      <Switch checked={deleteWorktree} onCheckedChange={(checked) => { if (!isDeleting) onChange(checked); }} disabled={isDeleting} className="data-[checked]:bg-destructive" aria-label="Delete worktree" />
    </div>
  );
}

function useLoadExpandedWorkspaceThreads(
  workspaces: Workspace[],
  expanded: Record<string, boolean>,
  loadThreads: (workspaceId: string) => Promise<void>,
) {
  const didLoadExpandedRef = useRef(false);
  useEffect(() => {
    if (workspaces.length === 0 || didLoadExpandedRef.current) return;
    didLoadExpandedRef.current = true;
    for (const workspace of workspaces) {
      if (expanded[workspace.id]) loadThreads(workspace.id);
    }
  }, [workspaces, expanded, loadThreads]);
}

function useLoadActiveWorkspaceWorktrees(
  activeWorkspaceId: string | null,
  threads: WorkspaceThread[],
  worktreesLoadedForWorkspace: string | null,
  loadWorktrees: (workspaceId: string) => Promise<void>,
) {
  useEffect(() => {
    if (!shouldLoadActiveWorkspaceWorktrees(activeWorkspaceId, worktreesLoadedForWorkspace, threads)) return;
    loadWorktrees(activeWorkspaceId);
  }, [activeWorkspaceId, threads, worktreesLoadedForWorkspace, loadWorktrees]);
}

function shouldLoadActiveWorkspaceWorktrees(
  activeWorkspaceId: string | null,
  worktreesLoadedForWorkspace: string | null,
  threads: WorkspaceThread[],
): activeWorkspaceId is string {
  if (!activeWorkspaceId || worktreesLoadedForWorkspace === activeWorkspaceId) return false;
  return threads.some((thread) => thread.workspace_id === activeWorkspaceId && thread.mode === "worktree" && Boolean(thread.worktree_path));
}

interface ContextMenuState {
  x: number;
  y: number;
  threadId: string;
  threadTitle: string;
  workspacePath: string;
  worktreePath: string | null;
}

interface DraftContextMenuState {
  x: number;
  y: number;
  draftId: string;
}

interface DeleteDialogState {
  threadId: string;
  threadTitle: string;
  worktreePath: string | null;
}

/** State for the workspace (project) delete confirmation dialog. */
interface WorkspaceDeleteDialogState {
  workspaceId: string;
  workspaceName: string;
}

/** State for the workspace rename dialog. */
interface WorkspaceRenameDialogState {
  workspaceId: string;
  workspaceName: string;
}

interface InlineEditState {
  threadId: string;
  title: string;
  originalTitle: string;
}

/** A thread with its nesting depth in the sidebar tree. */
interface ThreadTreeItem {
  thread: WorkspaceThread;
  depth: number;
}

/** Builds a depth-first flattened tree from a flat list of threads, ordered by parent-child relationships. */
function buildThreadTree(threads: WorkspaceThread[]): ThreadTreeItem[] {
  const childrenByParent = new Map<string, WorkspaceThread[]>();
  const roots: WorkspaceThread[] = [];
  const threadIds = new Set(threads.map((t) => t.id));

  for (const thread of threads) {
    if (!thread.parent_thread_id || !threadIds.has(thread.parent_thread_id)) {
      // Root thread, or orphan whose parent isn't in this list
      roots.push(thread);
    } else {
      const siblings = childrenByParent.get(thread.parent_thread_id) ?? [];
      siblings.push(thread);
      childrenByParent.set(thread.parent_thread_id, siblings);
    }
  }

  const result: ThreadTreeItem[] = [];
  function walk(thread: WorkspaceThread, depth: number) {
    result.push({ thread, depth });
    const children = childrenByParent.get(thread.id);
    if (children) {
      for (const child of children) {
        walk(child, depth + 1);
      }
    }
  }

  for (const root of roots) {
    walk(root, 0);
  }

  return result;
}

/** Sidebar tree listing workspaces and their threads with CRUD actions. */
export function ProjectTree() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeDraftId = useWorkspaceStore((s) => s.activeDraftId);
  const openThreadDraft = useWorkspaceStore((s) => s.openThreadDraft);
  const discardThreadDraft = useWorkspaceStore((s) => s.discardThreadDraft);
  const threadDrafts = useThreadDraftStore((s) => s.drafts);
  const threads = useWorkspaceStore((s) => s.threads);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const loadThreads = useWorkspaceStore((s) => s.loadThreads);
  const loadWorktrees = useWorkspaceStore((s) => s.loadWorktrees);
  const worktreesLoadedForWorkspace = useWorkspaceStore(
    (s) => s.worktreesLoadedForWorkspace,
  );
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const deleteThread = useWorkspaceStore((s) => s.deleteThread);
  const completeThread = useWorkspaceStore((s) => s.completeThread);
  const reopenThread = useWorkspaceStore((s) => s.reopenThread);
  const retryThreadCleanup = useWorkspaceStore((s) => s.retryThreadCleanup);
  const beginNewThread = useWorkspaceStore((s) => s.beginNewThread);
  const setPrimarySurface = useUiStore((s) => s.setPrimarySurface);
  const updateThreadTitle = useWorkspaceStore((s) => s.updateThreadTitle);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const error = useWorkspaceStore((s) => s.error);
  // Derive pending permission thread IDs directly in the selector with useShallow
  // so the component only re-renders when the actual set of IDs changes, not on
  // every unrelated threadStore update that creates a new permissionsByThread ref.
  const pendingPermissionIds = useThreadStore(
    useShallow((s) => {
      const ids: string[] = [];
      for (const [id, rec] of s.records) {
        if (rec.permissions.some((p) => !p.settled)) ids.push(id);
      }
      return ids;
    }),
  );
  const pendingPermissionThreadIds = useMemo(
    () => new Set(pendingPermissionIds),
    [pendingPermissionIds],
  );

  // Pre-group threads by workspace in one pass instead of filtering all threads per workspace.
  const threadsByWorkspace = useMemo(() => {
    const map = new Map<string, WorkspaceThread[]>();
    for (const t of threads) {
      const arr = map.get(t.workspace_id);
      if (arr) arr.push(t);
      else map.set(t.workspace_id, [t]);
    }
    return map;
  }, [threads]);

  // Drafts pin above the thread list, most recently edited first.
  const draftsByWorkspace = useMemo(() => {
    const map = new Map<string, ThreadDraft[]>();
    for (const draft of Object.values(threadDrafts)) {
      const arr = map.get(draft.workspaceId);
      if (arr) arr.push(draft);
      else map.set(draft.workspaceId, [draft]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return map;
  }, [threadDrafts]);

  const [expanded, setExpanded] =
    useState<Record<string, boolean>>(getExpandedState);
  const [threadListExpanded, setThreadListExpandedState] = useState<
    Record<string, boolean>
  >(getThreadListExpanded);
  const lifecycleViews = useUiStore((s) => s.projectThreadViews);
  const toggleLifecycleView = useUiStore((s) => s.toggleProjectThreadView);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draftContextMenu, setDraftContextMenu] =
    useState<DraftContextMenuState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [wsDeleteDialog, setWsDeleteDialog] =
    useState<WorkspaceDeleteDialogState | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [wsRenameDialog, setWsRenameDialog] =
    useState<WorkspaceRenameDialogState | null>(null);
  const [workspaceRenameValue, setWorkspaceRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    id: string;
    edge: "top" | "bottom";
  } | null>(null);
  // The pointerup that ends a drag still fires click on whatever row it lands
  // on; without a grace window that click toggles expansion or navigates.
  const suppressPostDragClickUntilRef = useRef(0);

  const workspaceIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  useLoadExpandedWorkspaceThreads(workspaces, expanded, loadThreads);

  // In-flight lifecycle flags outlive any one row; tearing the whole tree down
  // is the boundary where they should not linger.
  useEffect(() => () => resetLifecycleUiState(), []);

  // Persist expanded state
  useEffect(() => {
    setExpandedState(expanded);
  }, [expanded]);

  // Persist thread-list expanded state
  useEffect(() => {
    setThreadListExpanded(threadListExpanded);
  }, [threadListExpanded]);

  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<VirtualViewport | null>(null);
  const [hosts, setHosts] = useState<readonly VirtualHost[]>([]);

  const checksById = useWorkspaceStore(useShallow((s) => s.checksById));

  const toggleThreadList = useCallback((wsId: string) => {
    setThreadListExpandedState((prev) => ({ ...prev, [wsId]: !prev[wsId] }));
  }, []);
  useLoadActiveWorkspaceWorktrees(
    activeWorkspaceId,
    threads,
    worktreesLoadedForWorkspace,
    loadWorktrees,
  );

  // F2 shortcut: rename the active thread
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const thread = activeThreadForRename(event, activeThreadId, inlineEdit, threads);
      if (!thread) return;
      event.preventDefault();
      setInlineEdit({
        threadId: thread.id,
        title: thread.title,
        originalTitle: thread.title,
      });
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeThreadId, threads, inlineEdit]);

  const toggleExpand = useCallback(
    (wsId: string) => {
      // A click in the same tick as a drag release is the drop, not a toggle.
      if (Date.now() < suppressPostDragClickUntilRef.current) return;
      const isExpanding = !expanded[wsId];
      setExpanded((prev) => ({ ...prev, [wsId]: !prev[wsId] }));
      if (isExpanding) {
        // Load threads independently without changing the active workspace.
        // Updaters must stay pure: StrictMode can invoke them twice, which
        // would double-fire this load.
        loadThreads(wsId);
      }
    },
    [expanded, loadThreads],
  );

  // Open the palette's folder-browse view instead of using the native OS dialog.
  // This works across Electron and standalone web, and avoids the desktopBridge dependency.
  const handleOpenFolder = useCallback(() => {
    useCommandPaletteStore.getState().open({ intent: "addProject" });
  }, []);

  const handleThreadContextMenu = useCallback(
    (e: React.MouseEvent, thread: Thread, workspacePath: string) => {
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        threadId: thread.id,
        threadTitle: thread.title,
        workspacePath,
        worktreePath: thread.worktree_path,
      });
    },
    [],
  );

  // Stable callbacks that accept wsId to avoid per-workspace closures in the render loop.
  const handleSelectThread = useCallback(
    (wsId: string, threadId: string) => {
      setActiveWorkspace(wsId);
      setActiveThread(threadId);
    },
    [setActiveWorkspace, setActiveThread],
  );

  const handleCreateThread = useCallback(
    (wsId: string) => {
      setPrimarySurface("chat");
      beginNewThread(wsId);
    },
    [beginNewThread, setPrimarySurface],
  );

  const handleOpenDraft = useCallback(
    (wsId: string, draftId: string) => {
      setPrimarySurface("chat");
      openThreadDraft(wsId, draftId);
    },
    [openThreadDraft, setPrimarySurface],
  );

  const handleDiscardDraft = useCallback(
    (draftId: string) => discardThreadDraft(draftId),
    [discardThreadDraft],
  );

  const handleDraftContextMenu = useCallback(
    (event: React.MouseEvent, draftId: string) => {
      event.preventDefault();
      setDraftContextMenu({ x: event.clientX, y: event.clientY, draftId });
    },
    [],
  );

  const handleDeleteWorkspace = useCallback((wsId: string) => {
    const ws = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === wsId);
    if (ws) {
      setWsDeleteDialog({ workspaceId: ws.id, workspaceName: ws.name });
    }
  }, []);

  const handleRenameWorkspace = useCallback((workspace: Workspace) => {
    setWorkspaceRenameValue(workspace.name);
    setWsRenameDialog({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    });
  }, []);

  const handleInlineEditChange = useCallback((title: string) => {
    setInlineEdit((prev) => (prev ? { ...prev, title } : null));
  }, []);

  const handleInlineEditCancel = useCallback(() => {
    setInlineEdit(null);
  }, []);

  const handleInlineEditCommit = useCallback(async () => {
    if (!inlineEdit) return;
    const newTitle = inlineEdit.title.trim();
    if (!newTitle || newTitle === inlineEdit.originalTitle) {
      setInlineEdit(null);
      return;
    }
    try {
      await updateThreadTitle(inlineEdit.threadId, newTitle);
      setInlineEdit(null);
    } catch {
      // Error surfaced via store.error; keep editor open so user can retry
    }
  }, [inlineEdit, updateThreadTitle]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteDialog || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteThread(deleteDialog.threadId, deleteWorktree);
      setDeleteDialog(null);
      setDeleteWorktree(false);
    } catch {
      // Error shown via store.error; keep dialog open so user can retry
    } finally {
      setIsDeleting(false);
    }
  }, [deleteDialog, deleteWorktree, deleteThread, isDeleting]);

  const handleWorkspaceDeleteConfirm = useCallback(async () => {
    if (!wsDeleteDialog) return;
    try {
      await deleteWorkspace(wsDeleteDialog.workspaceId);
      setWsDeleteDialog(null);
    } catch {
      // Error shown via store.error; keep dialog open so user can retry
    }
  }, [wsDeleteDialog, deleteWorkspace]);

  const handleWorkspaceRenameConfirm = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!wsRenameDialog || isRenaming) return;

      const name = workspaceRenameValue.trim();
      if (!name || name === wsRenameDialog.workspaceName) {
        setWsRenameDialog(null);
        return;
      }

      setIsRenaming(true);
      try {
        await renameWorkspace(wsRenameDialog.workspaceId, name);
        setWsRenameDialog(null);
      } catch {
        // The workspace store retains the failure message for the sidebar error rail.
      } finally {
        setIsRenaming(false);
      }
    },
    [isRenaming, renameWorkspace, workspaceRenameValue, wsRenameDialog],
  );

  const handleStartInlineEdit = useCallback(
    (threadId: string) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) return;
      setInlineEdit({
        threadId,
        title: thread.title,
        originalTitle: thread.title,
      });
    },
    [threads],
  );

  const handleProjectDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  // onDragMove, not onDragOver: the edge must track the pointer within one
  // group, and onDragOver only fires when the over target itself changes.
  const handleProjectDragMove = useCallback((event: DragMoveEvent) => {
    const edge = dropEdgeForEvent(event);
    setDropIndicator(
      edge !== null ? { id: String(event.over!.id), edge } : null,
    );
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      setDropIndicator(null);
      suppressPostDragClickUntilRef.current = Date.now() + 250;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = workspaceIds.indexOf(active.id as string);
      const overIndex = workspaceIds.indexOf(over.id as string);
      if (oldIndex < 0 || overIndex < 0) return;
      // Pointer drags land on the indicated boundary; keyboard drags keep the
      // sortable convention of taking the over item's index.
      let newIndex = overIndex;
      const edge = dropEdgeForEvent(event);
      if (edge !== null && "clientY" in event.activatorEvent) {
        // The boundary counts positions before the dragged row is removed.
        const boundary = overIndex + (edge === "bottom" ? 1 : 0);
        newIndex = boundary > oldIndex ? boundary - 1 : boundary;
      }
      void reorderWorkspace(active.id as string, newIndex);
    },
    [workspaceIds, reorderWorkspace],
  );

  const handleProjectDragCancel = useCallback(() => {
    setActiveDragId(null);
    setDropIndicator(null);
    suppressPostDragClickUntilRef.current = Date.now() + 250;
  }, []);

  /**
   * Only the project list viewport may autoscroll during drag so outer sidebar
   * regions (or the document) are not pulled by `@dnd-kit` when reordering.
   */
  const projectTreeAutoScroll = useMemo(
    () => ({
      canScroll(element: Element) {
        const vp = controllerRef.current?.viewport;
        return vp != null && element === vp;
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    if (!activeDragId) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [activeDragId]);

  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const availableProviders = useProviderAvailabilityStore((s) => s.providers);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  // Normalized set of existing worktree paths for stale detection.
  const validWorktreePaths = useMemo(() => {
    const set = new Set<string>();
    for (const wt of worktrees) {
      set.add(wt.path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase());
    }
    return set;
  }, [worktrees]);

  // Per-thread last-click timestamp. Used to detect a second click within the
  // double-click window without delaying the first click's navigation.
  const lastClickTimeRef = useRef<Map<string, number>>(new Map());

  const handleThreadClick = useCallback(
    (wsId: string, threadId: string) => {
      // If already editing this thread, clicks are absorbed to avoid conflicting with the input.
      if (inlineEdit?.threadId === threadId) return;
      if (Date.now() < suppressPostDragClickUntilRef.current) return;

      const now = Date.now();
      const hadPrevious = lastClickTimeRef.current.has(threadId);
      const last = lastClickTimeRef.current.get(threadId) ?? 0;
      const elapsed = now - last;
      lastClickTimeRef.current.set(threadId, now);

      if (hadPrevious && elapsed < DOUBLE_CLICK_THRESHOLD_MS) {
        // Double-click: enter inline rename. The first click has already navigated,
        // which is fine — the row is now active and rename happens in place.
        lastClickTimeRef.current.delete(threadId);
        handleStartInlineEdit(threadId);
      } else {
        // Single click navigates immediately. No artificial delay.
        handleSelectThread(wsId, threadId);
      }
    },
    [inlineEdit, handleSelectThread, handleStartInlineEdit],
  );

  const handleThreadDoubleClick = useCallback(
    (threadId: string) => {
      if (inlineEdit?.threadId === threadId) return;
      lastClickTimeRef.current.delete(threadId);
      handleStartInlineEdit(threadId);
    },
    [inlineEdit, handleStartInlineEdit],
  );

  // The vlist viewport renders one row per project group: workspace header plus
  // its expanded thread section. Groups outside the viewport are never mounted.
  const rows = useMemo<ProjectTreeRowEntry[]>(
    () =>
      buildProjectTreeRows({
        workspaces,
        threadsByWorkspace,
        draftsByWorkspace,
        activeDraftId,
        expanded,
        threadListExpanded,
        lifecycleViews,
        activeThreadId,
        activeWorkspaceId,
        runningThreadIds,
      }),
    [
      workspaces,
      threadsByWorkspace,
      draftsByWorkspace,
      activeDraftId,
      expanded,
      threadListExpanded,
      lifecycleViews,
      activeThreadId,
      activeWorkspaceId,
      runningThreadIds,
    ],
  );

  const rowsById = useMemo(
    () => new Map(rows.map((entry) => [entry.id, entry])),
    [rows],
  );

  // The virtualizer unmounts rows that leave the render window, including the
  // dragged row when auto-scroll moves its slot off screen. The overlay keeps
  // a pointer-following clone so the drag never loses its visual.
  const dragWorkspaceRow = useMemo(
    () => findWorkspaceRow(rowsById, activeDragId),
    [rowsById, activeDragId],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const view = new VirtualViewport(
      container,
      setHosts,
      noopViewportPosition,
      { classPrefix: "project-tree", ariaLabel: "Projects" },
    );
    controllerRef.current = view;
    return () => {
      view.destroy();
      controllerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    controllerRef.current?.setRows(rows);
  }, [rows]);

  const rowCtx = useMemo<ProjectTreeRowContext>(
    () => ({
      checksById,
      pendingPermissionThreadIds,
      inlineEdit,
      worktreesLoadedFor: worktreesLoadedForWorkspace,
      validWorktreePaths,
      availableProviders,
      onToggle: toggleExpand,
      onToggleLifecycleView: toggleLifecycleView,
      onCreateThread: handleCreateThread,
      onDelete: handleDeleteWorkspace,
      onRename: handleRenameWorkspace,
      onToggleThreadList: toggleThreadList,
      onInlineEditChange: handleInlineEditChange,
      onInlineEditCommit: handleInlineEditCommit,
      onInlineEditCancel: handleInlineEditCancel,
      onThreadClick: handleThreadClick,
      onThreadDoubleClick: handleThreadDoubleClick,
      onSelectThread: handleSelectThread,
      onThreadContextMenu: handleThreadContextMenu,
      onCompleteThread: completeThread,
      onReopenThread: reopenThread,
      onRetryThreadCleanup: retryThreadCleanup,
      onOpenDraft: handleOpenDraft,
      onDiscardDraft: handleDiscardDraft,
      onDraftContextMenu: handleDraftContextMenu,
      dropIndicator,
    }),
    [
      checksById,
      pendingPermissionThreadIds,
      inlineEdit,
      worktreesLoadedForWorkspace,
      validWorktreePaths,
      availableProviders,
      toggleExpand,
      toggleLifecycleView,
      handleCreateThread,
      handleDeleteWorkspace,
      handleRenameWorkspace,
      toggleThreadList,
      handleInlineEditChange,
      handleInlineEditCommit,
      handleInlineEditCancel,
      handleThreadClick,
      handleThreadDoubleClick,
      handleSelectThread,
      handleThreadContextMenu,
      completeThread,
      reopenThread,
      retryThreadCleanup,
      handleOpenDraft,
      handleDiscardDraft,
      handleDraftContextMenu,
      dropIndicator,
    ],
  );

  const renderRow = useCallback(
    (entry: ProjectTreeRowEntry): ReactNode => (
      <div className="px-1.5 pb-1">
        <SortableProjectRow row={entry.row} ctx={rowCtx} />
      </div>
    ),
    [rowCtx],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="mb-1 flex items-center justify-between px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Projects
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleOpenFolder}
                aria-label="Add project"
                className="text-muted-foreground hover:text-foreground"
              >
                <Plus size={15} />
              </Button>
            }
          />
          <TooltipContent side="right" className="text-xs">
            Add project
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          data-testid="thread-list"
          className="h-full"
        />
        <DndContext
          sensors={sensors}
          collisionDetection={projectTreeCollision}
          modifiers={PROJECT_DND_MODIFIERS}
          measuring={PROJECT_DND_MEASURING}
          autoScroll={projectTreeAutoScroll}
          onDragStart={handleProjectDragStart}
          onDragMove={handleProjectDragMove}
          onDragEnd={handleProjectDragEnd}
          onDragCancel={handleProjectDragCancel}
        >
          <SortableContext
            items={workspaceIds}
            strategy={STATIC_SORT_STRATEGY}
          >
            <VirtualRows
              viewport={controllerRef.current}
              hosts={hosts}
              items={rowsById}
              renderItem={renderRow}
            />
          </SortableContext>
          <ProjectTreeDragOverlay row={dragWorkspaceRow} ctx={rowCtx} />
        </DndContext>

        {workspaces.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 py-12">
            {/* Lucide FolderPlus echoes the action below — keeps the empty state on-brand
                with the rest of the picker (no unicode glyphs). Larger/quieter than the CTA. */}
            <FolderPlus
              size={28}
              strokeWidth={1.25}
              aria-hidden
              className="text-muted-foreground/25"
            />
            <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/45">
              No projects yet
            </p>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleOpenFolder}
              className="group h-auto gap-1.5 rounded-md border border-border/50 px-2.5 py-1 text-[11.5px] font-normal text-muted-foreground/80 hover:border-border hover:bg-accent/50 hover:text-foreground"
            >
              <FolderPlus
                size={11}
                className="opacity-70 group-hover:opacity-100"
              />
              Open a folder
            </Button>
          </div>
        )}
      </div>

      {error && <p className="px-3 py-1 text-xs text-destructive">{error}</p>}

      <ThreadContextMenuOverlay
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        onStartRename={setInlineEdit}
        onDeleteThread={(dialog) => {
          setDeleteDialog(dialog);
          setDeleteWorktree(false);
        }}
      />

      <DraftContextMenuOverlay
        contextMenu={draftContextMenu}
        onClose={() => setDraftContextMenu(null)}
        onDeleteDraft={handleDiscardDraft}
      />

      <ThreadDeleteDialog
        dialog={deleteDialog}
        deleteWorktree={deleteWorktree}
        isDeleting={isDeleting}
        onDeleteWorktreeChange={setDeleteWorktree}
        onClose={() => {
          setDeleteDialog(null);
          setDeleteWorktree(false);
        }}
        onConfirm={handleDeleteConfirm}
      />

      {/* Workspace Delete Confirmation Dialog */}
      <Dialog
        open={wsDeleteDialog !== null}
        onOpenChange={(open) => {
          if (!open) setWsDeleteDialog(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md overflow-hidden"
        >
          <div className="flex flex-col gap-2">
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;
              {wsDeleteDialog?.workspaceName}&rdquo;? All threads in this
              project will also be removed. This action cannot be undone.
            </DialogDescription>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setWsDeleteDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleWorkspaceDeleteConfirm}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={wsRenameDialog !== null}
        onOpenChange={(open) => {
          if (!open && !isRenaming) setWsRenameDialog(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md overflow-hidden"
        >
          <form
            onSubmit={handleWorkspaceRenameConfirm}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2">
              <DialogTitle>Rename project</DialogTitle>
              <DialogDescription>
                Choose a new name for {wsRenameDialog?.workspaceName}.
              </DialogDescription>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-rename">Project name</Label>
              <Input
                id="workspace-rename"
                value={workspaceRenameValue}
                onChange={(event) =>
                  setWorkspaceRenameValue(event.target.value)
                }
                maxLength={120}
                autoFocus
                disabled={isRenaming}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isRenaming}
                onClick={() => setWsRenameDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  isRenaming || workspaceRenameValue.trim().length === 0
                }
              >
                {isRenaming && <Spinner size={14} className="text-current" />}
                {isRenaming ? "Renaming..." : "Rename"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- Flattened virtual rows: a workspace header plus its expanded children ---

/** The project sidebar groups threads by completion state per workspace. */
type ProjectLifecycleView = "active" | "completed";

/** One row in the flattened sidebar list rendered by the shared vlist viewport. */
/** One virtual row: a whole project group (header plus expanded thread section). */
interface ProjectTreeRowData {
  readonly workspace: Workspace;
  readonly threadList: ThreadListSummary;
  readonly drafts: readonly ThreadDraft[];
  readonly activeDraftId: string | null;
  readonly lifecycleView: ProjectLifecycleView;
  readonly isExpanded: boolean;
  readonly isThreadListExpanded: boolean;
  readonly isActive: boolean;
  readonly hasRunning: boolean;
}

interface ProjectTreeRowEntry {
  readonly id: string;
  readonly height: number;
  readonly row: ProjectTreeRowData;
}

interface ProjectTreeRowsInput {
  readonly workspaces: Workspace[];
  readonly threadsByWorkspace: ReadonlyMap<string, WorkspaceThread[]>;
  readonly draftsByWorkspace: ReadonlyMap<string, readonly ThreadDraft[]>;
  readonly activeDraftId: string | null;
  readonly expanded: Record<string, boolean>;
  readonly threadListExpanded: Record<string, boolean>;
  readonly lifecycleViews: Record<string, ProjectLifecycleView>;
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly runningThreadIds: ReadonlySet<string>;
}

/** Maps workspaces to virtual rows; children live inside the group row so a
 * drag moves the project as one unit and drag start never shifts layout. */
function buildProjectTreeRows(
  input: ProjectTreeRowsInput,
): ProjectTreeRowEntry[] {
  return input.workspaces.map((workspace) => {
    const wsThreads =
      input.threadsByWorkspace.get(workspace.id) ?? EMPTY_THREADS;
    const lifecycleView = input.lifecycleViews[workspace.id] ?? "active";
    const isExpanded = input.expanded[workspace.id] ?? false;
    const isThreadListExpanded =
      input.threadListExpanded[workspace.id] ?? false;
    return {
      id: `ws:${workspace.id}`,
      height: 32,
      row: {
        workspace,
        threadList: computeThreadListSummary(
          wsThreads,
          lifecycleView,
          isThreadListExpanded,
          input.activeThreadId,
          isExpanded,
        ),
        drafts: input.draftsByWorkspace.get(workspace.id) ?? EMPTY_DRAFTS,
        activeDraftId: input.activeDraftId,
        lifecycleView,
        isExpanded,
        isThreadListExpanded,
        isActive: input.activeWorkspaceId === workspace.id,
        hasRunning: wsThreads.some((thread) =>
          input.runningThreadIds.has(thread.id),
        ),
      },
    };
  });
}

/** Looks up the dragged workspace's row data for the drag overlay. */
function findWorkspaceRow(
  rowsById: ReadonlyMap<string, ProjectTreeRowEntry>,
  activeDragId: string | null,
): ProjectTreeRowData | undefined {
  return activeDragId === null
    ? undefined
    : rowsById.get(`ws:${activeDragId}`)?.row;
}

/** Stable scroll-position sink; the tree only reads positions through anchors. */
function noopViewportPosition(_position: ViewportPosition): void {}

/**
 * Picks which edge of the hovered group the dragged row inserts at. Pointer
 * drags compare the pointer against the group's midpoint; keyboard drags use
 * the travel direction. Dropping on the dragged row itself shows no edge.
 */
function dropEdgeForEvent(
  event: DragMoveEvent | DragEndEvent,
): "top" | "bottom" | null {
  const over = event.over;
  if (!over || over.id === event.active.id) return null;
  const activator = event.activatorEvent;
  if (!("clientY" in activator)) {
    return event.delta.y < 0 ? "top" : "bottom";
  }
  const pointerY =
    (activator as MouseEvent).clientY + event.delta.y;
  const midpoint = over.rect.top + over.rect.height / 2;
  return pointerY < midpoint ? "top" : "bottom";
}

interface ThreadRowProps {
  workspaceName: string;
  thread: WorkspaceThread;
  depth: number;
  hasPendingPermission: boolean;
  checks?: ChecksStatus;
  isEditing: boolean;
  inlineEdit: InlineEditState | null;
  worktreesLoadedFor: string | null;
  validWorktreePaths: Set<string>;
  availableProviders: Array<{
    id: string;
    enabled: boolean;
    cli: { status: string };
  }>;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onThreadClick: (threadId: string) => void;
  onThreadDoubleClick: (threadId: string) => void;
  onSelectThread: (id: string) => void;
  onThreadContextMenu: (e: React.MouseEvent, thread: Thread) => void;
  onCompleteThread: (threadId: string) => Promise<void>;
  onReopenThread: (threadId: string) => Promise<void>;
  onRetryThreadCleanup: (threadId: string) => Promise<void>;
}

/** Renders one sidebar thread row and subscribes only to its own active and running state. */
const ThreadRow = memo(function ThreadRow({
  workspaceName,
  thread,
  depth,
  hasPendingPermission,
  checks,
  isEditing,
  inlineEdit,
  worktreesLoadedFor,
  validWorktreePaths,
  availableProviders,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  onThreadClick,
  onThreadDoubleClick,
  onSelectThread,
  onThreadContextMenu,
  onCompleteThread,
  onReopenThread,
  onRetryThreadCleanup,
}: ThreadRowProps) {
  const isActive = useWorkspaceStore((s) => s.activeThreadId === thread.id);
  const isRunning = useThreadStore((s) => isThreadExecuting(thread.id, s));
  const startupPending = useWorkspaceStore((s) => s.pendingStartupByThreadId[thread.id] !== undefined);
  const automaticSetup = useProjectAutomaticSetup(
    thread.id,
    thread.mode === "worktree" && thread.worktree_managed === true,
  );
  const automaticSetupState = automaticSetup.snapshot.attempt?.state;
  const isSetupRunning = automaticSetup.snapshot.gate === "blocked"
    && (automaticSetupState === "queued" || automaticSetupState === "running");
  const isSetupAwaitingResponse = automaticSetup.snapshot.gate === "blocked"
    && (automaticSetupState === "failed" || automaticSetupState === "interrupted");
  const isSetupAwaitingApproval = automaticSetup.snapshot.gate === "blocked"
    && automaticSetupState === "awaiting-approval";
  const isRecoveryInterrupted = useRecoveryIncidentStore((state) =>
    hasRecoveryEntry(state, thread.workspace_id, thread.id),
  );
  const presentation = createThreadRowPresentation(
    thread,
    checks,
    isRunning,
    isSetupRunning,
    isSetupAwaitingResponse,
    hasPendingPermission,
    isRecoveryInterrupted,
    isSetupAwaitingApproval,
    worktreesLoadedFor,
    validWorktreePaths,
    availableProviders,
    startupPending,
  );
  const lifecycle = useThreadLifecycleActions({
    thread,
    isEditing,
    isRunning,
    hasPendingPermission,
    startupPending,
    isUserCompleted: presentation.isUserCompleted,
    cleanupBlocked: presentation.cleanupBlocked,
    onCompleteThread,
    onReopenThread,
    onRetryThreadCleanup,
  });
  // Blur cancels an inline rename; virtualization unmounts a row without ever
  // firing blur, so leaving the DOM mid-edit cancels it instead of stashing a
  // detached draft that would reappear on remount.
  const isEditingRef = useRef(isEditing);
  const cancelEditRef = useRef(onInlineEditCancel);
  useEffect(() => {
    isEditingRef.current = isEditing;
    cancelEditRef.current = onInlineEditCancel;
  });
  useEffect(
    () => () => {
      if (isEditingRef.current) cancelEditRef.current();
    },
    [],
  );
  return (
    <ThreadRowVisual
      {...{
        workspaceName,
        thread,
        depth,
        checks,
        isEditing,
        inlineEdit,
        onInlineEditChange,
        onInlineEditCommit,
        onInlineEditCancel,
        onThreadClick,
        onThreadDoubleClick,
        onSelectThread,
        onThreadContextMenu,
      }}
      isActive={isActive}
      presentation={presentation}
      lifecycle={lifecycle}
    />
  );
});

interface ThreadRowPresentation {
  marker: ReturnType<typeof getThreadStateMarker>;
  isRunning: boolean;
  showPrCi: boolean;
  isStaleWorktree: boolean;
  providerMeta: ReturnType<typeof getProviderMeta>;
  unusable: boolean;
  unusableReason: string;
  scaffoldDim: string | false | null;
  isUserCompleted: boolean;
  cleanupBlocked: boolean;
  showEndMarker: boolean;
}

interface ThreadRowLifecycleActions {
  isLifecyclePending: boolean;
  isCleanupRetryPending: boolean;
  cleanupStatusLabel: string | null;
  lifecycleUnavailable: boolean;
  handleLifecycleClick: (event: React.MouseEvent) => Promise<void>;
  handleCleanupRetry: (event: React.MouseEvent) => Promise<void>;
}

interface ThreadRowVisualProps {
  workspaceName: string;
  thread: WorkspaceThread;
  depth: number;
  checks: ChecksStatus | undefined;
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
  checks: ChecksStatus | undefined,
  isRunning: boolean,
  isSetupRunning: boolean,
  isSetupAwaitingResponse: boolean,
  hasPendingPermission: boolean,
  isRecoveryInterrupted: boolean,
  isSetupAwaitingApproval: boolean,
  worktreesLoadedFor: string | null,
  validWorktreePaths: Set<string>,
  availableProviders: ThreadRowProps["availableProviders"],
  startupPending: boolean,
): ThreadRowPresentation {
  const marker = getThreadStateMarker({
    thread,
    checks,
    isRunning,
    isSetupRunning,
    isSetupAwaitingResponse,
    hasPendingPermission: hasPendingPermission || isSetupAwaitingApproval,
    isRecoveryInterrupted,
  });
  const showPrCi = shouldShowThreadPrCi(thread, checks, marker);
  const isUserCompleted = thread.user_completed_at !== null;
  return {
    marker,
    isRunning,
    showPrCi,
    isStaleWorktree: hasStaleThreadWorktree(thread, worktreesLoadedFor, validWorktreePaths),
    ...threadProviderPresentation(thread.provider, availableProviders),
    scaffoldDim: thread.clientPreparing || thread.clientError || startupPending ? "opacity-[0.72]" : false,
    isUserCompleted,
    cleanupBlocked: isUserCompleted && thread.cleanup_state === "blocked",
    showEndMarker: marker.kind !== "time" && (!showPrCi || marker.kind !== "ci"),
  };
}

function shouldShowThreadPrCi(
  thread: WorkspaceThread,
  checks: ChecksStatus | undefined,
  marker: ReturnType<typeof getThreadStateMarker>,
): boolean {
  return isPrable(thread)
    && thread.pr_number !== null
    && checks !== undefined
    && checks.aggregate !== "no_checks"
    && marker.kind !== "action"
    && marker.kind !== "setup"
    && marker.kind !== "running";
}

function hasStaleThreadWorktree(
  thread: WorkspaceThread,
  worktreesLoadedFor: string | null,
  validWorktreePaths: Set<string>,
): boolean {
  if (worktreesLoadedFor !== thread.workspace_id || thread.mode !== "worktree") return false;
  if (!thread.worktree_path) return false;
  const path = thread.worktree_path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return !validWorktreePaths.has(path);
}

function threadProviderPresentation(
  provider: string,
  availableProviders: ThreadRowProps["availableProviders"],
): Pick<ThreadRowPresentation, "providerMeta" | "unusable" | "unusableReason"> {
  const providerRow = availableProviders.find((candidate) => candidate.id === provider);
  if (!providerRow) {
    return { providerMeta: getProviderMeta(provider), unusable: false, unusableReason: "" };
  }
  const unusable = !providerRow.enabled || providerRow.cli.status === "not_found";
  const unusableReason = providerRow.enabled ? "CLI not found" : "Provider disabled";
  return { providerMeta: getProviderMeta(provider), unusable, unusableReason };
}

// In-flight lifecycle flags live outside React: virtualized rows unmount
// off-screen, and useState would drop a pending spinner or a retry error
// mid-flight. Rows subscribe to their own thread's entry.
const lifecycleUiListeners = new Set<() => void>();
const lifecyclePendingByThread = new Map<string, boolean>();
const cleanupRetryByThread = new Map<
  string,
  { pending: boolean; error: string | null }
>();
const IDLE_CLEANUP_RETRY = { pending: false, error: null } as const;

function notifyLifecycleUi() {
  for (const listener of lifecycleUiListeners) listener();
}

function setLifecycleUiPending(threadId: string, pending: boolean) {
  if (pending) lifecyclePendingByThread.set(threadId, true);
  else lifecyclePendingByThread.delete(threadId);
  notifyLifecycleUi();
}

function setCleanupRetryUi(
  threadId: string,
  value: { pending: boolean; error: string | null } | null,
) {
  if (value) cleanupRetryByThread.set(threadId, value);
  else cleanupRetryByThread.delete(threadId);
  notifyLifecycleUi();
}

function subscribeLifecycleUi(listener: () => void) {
  lifecycleUiListeners.add(listener);
  return () => {
    lifecycleUiListeners.delete(listener);
  };
}

/** Drops in-flight lifecycle flags when the tree unmounts (RTL auto-cleanup
 * also runs it between tests). */
function resetLifecycleUiState() {
  lifecyclePendingByThread.clear();
  cleanupRetryByThread.clear();
  notifyLifecycleUi();
}

function useThreadLifecycleActions({
  thread,
  isEditing,
  isRunning,
  hasPendingPermission,
  startupPending,
  isUserCompleted,
  cleanupBlocked,
  onCompleteThread,
  onReopenThread,
  onRetryThreadCleanup,
}: Pick<ThreadRowProps, "thread" | "isEditing" | "hasPendingPermission" | "onCompleteThread" | "onReopenThread" | "onRetryThreadCleanup"> & {
  isRunning: boolean;
  startupPending: boolean;
  isUserCompleted: boolean;
  cleanupBlocked: boolean;
}): ThreadRowLifecycleActions {
  const isLifecyclePending = useSyncExternalStore(
    subscribeLifecycleUi,
    () => lifecyclePendingByThread.get(thread.id) === true,
    () => false,
  );
  const cleanupRetry = useSyncExternalStore(
    subscribeLifecycleUi,
    () => cleanupRetryByThread.get(thread.id) ?? IDLE_CLEANUP_RETRY,
    () => IDLE_CLEANUP_RETRY,
  );
  const isCleanupRetryPending = cleanupRetry.pending;
  const cleanupRetryError = cleanupRetry.error;
  const lifecycleUnavailable = isLifecyclePending
    || isEditing
    || isRunning
    || hasPendingPermission
    || startupPending
    || Boolean(thread.clientPreparing || thread.clientError);
  const handleLifecycleClick = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    // Read the map directly: two clicks in one frame both pass the committed
    // snapshot before the subscribed re-render lands.
    if (lifecycleUnavailable
      || lifecyclePendingByThread.get(thread.id)
      || useWorkspaceStore.getState().pendingStartupByThreadId[thread.id] !== undefined) return;
    setLifecycleUiPending(thread.id, true);
    try {
      const updateLifecycle = isUserCompleted ? onReopenThread : onCompleteThread;
      await updateLifecycle(thread.id);
    } catch {
      // The store action already surfaces the failure via workspaceStore.error;
      // swallowing here keeps expected rejections (e.g. a pending mutation when
      // a turn raced the click) out of the unhandled-rejection crash reporter.
    } finally {
      setLifecycleUiPending(thread.id, false);
    }
  }, [isUserCompleted, lifecycleUnavailable, onCompleteThread, onReopenThread, thread.id]);
  const handleCleanupRetry = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!cleanupBlocked || cleanupRetryByThread.get(thread.id)?.pending) return;
    setCleanupRetryUi(thread.id, { pending: true, error: null });
    try {
      await onRetryThreadCleanup(thread.id);
      setCleanupRetryUi(thread.id, null);
    } catch (cause: unknown) {
      // A tree unmount mid-flight clears the map; writing here would leave a
      // phantom error that the next mount renders.
      if (cleanupRetryByThread.has(thread.id)) {
        setCleanupRetryUi(thread.id, { pending: false, error: String(cause) });
      }
    }
  }, [cleanupBlocked, onRetryThreadCleanup, thread.id]);
  return {
    isLifecyclePending,
    isCleanupRetryPending,
    cleanupStatusLabel: cleanupStatusLabel(cleanupRetryError, thread.cleanup_state),
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
  checks,
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
      <ThreadRowLeading thread={thread} depth={depth} presentation={presentation} lifecycle={lifecycle} />
      <ThreadRowContent
        thread={thread}
        isEditing={isEditing}
        inlineEdit={inlineEdit}
        presentation={presentation}
        cleanupStatusLabel={lifecycle.cleanupStatusLabel}
        onInlineEditChange={onInlineEditChange}
        onInlineEditCommit={onInlineEditCommit}
        onInlineEditCancel={onInlineEditCancel}
      />
      <ThreadCleanupRetry thread={thread} isEditing={isEditing} cleanupBlocked={presentation.cleanupBlocked} lifecycle={lifecycle} />
      <ThreadPrStatus thread={thread} checks={checks} isEditing={isEditing} presentation={presentation} />
      <ThreadEndMarker isEditing={isEditing} presentation={presentation} />
    </ThreadRowSurface>
  );
  return <ThreadRowPreview isEditing={isEditing} row={row} workspaceName={workspaceName} thread={thread} />;
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
        "group/row relative flex min-h-8 items-center gap-2 rounded-md pr-2 text-[13px] cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        isActive ? "bg-accent text-foreground" : "text-muted-foreground/85 hover:bg-accent/40 hover:text-foreground",
        triggerClassName,
      )}
      style={{ paddingLeft: `${46 + depth * 12}px` }}
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

function isThreadRowNavigationEvent(event: React.KeyboardEvent): boolean {
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

function ThreadRowLeading({
  thread,
  depth,
  presentation,
  lifecycle,
}: Pick<ThreadRowVisualProps, "thread" | "depth" | "presentation" | "lifecycle">) {
  const ProviderIcon = presentation.providerMeta.icon;
  return (
    <span className="absolute left-0.5 top-1/2 flex -translate-y-1/2 items-center justify-end gap-1" style={{ width: `${40 + depth * 12}px` }}>
      <ThreadLifecycleButton thread={thread} isRunning={presentation.isRunning} presentation={presentation} lifecycle={lifecycle} />
      <span
        aria-label={`Provider, ${presentation.providerMeta.label}`}
        className={cn(
          "-mt-px flex h-4 w-4 items-center justify-center",
          presentation.providerMeta.color,
          presentation.scaffoldDim,
          presentation.isUserCompleted && "grayscale opacity-45",
        )}
      >
        <ProviderIcon size={12} />
      </span>
    </span>
  );
}

function ThreadLifecycleButton({
  thread,
  isRunning,
  presentation,
  lifecycle,
}: Pick<ThreadRowVisualProps, "thread" | "presentation" | "lifecycle"> & { isRunning: boolean }) {
  const actionLabel = presentation.isUserCompleted ? `Reopen ${thread.title}` : `Complete ${thread.title}`;
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={actionLabel}
          disabled={lifecycle.lifecycleUnavailable}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={lifecycle.handleLifecycleClick}
          className={cn(
            "size-5 shrink-0 rounded-full p-0 text-muted-foreground/65 opacity-0 transition-opacity shadow-none hover:bg-transparent hover:text-foreground group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed",
            isRunning && "disabled:opacity-0 group-hover/row:disabled:opacity-100 group-focus-visible/row:disabled:opacity-100",
          )}
        >
          <ThreadLifecycleIcon isPending={lifecycle.isLifecyclePending} isCompleted={presentation.isUserCompleted} />
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">
        {presentation.isUserCompleted ? "Undo completion" : "Complete thread"}
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadLifecycleIcon({ isPending, isCompleted }: { isPending: boolean; isCompleted: boolean }) {
  if (isPending) return <Spinner size={11} />;
  if (isCompleted) return <Check size={13} strokeWidth={2.5} aria-hidden />;
  return <Circle size={13} strokeWidth={1.8} aria-hidden />;
}

function ThreadRowContent({
  thread,
  isEditing,
  inlineEdit,
  presentation,
  cleanupStatusLabel: statusLabel,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
}: Pick<ThreadRowVisualProps, "thread" | "isEditing" | "inlineEdit" | "presentation" | "onInlineEditChange" | "onInlineEditCommit" | "onInlineEditCancel"> & { cleanupStatusLabel: string | null }) {
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-2", presentation.scaffoldDim)}>
      {isEditing ? (
        <Input
          type="text"
          size="xs"
          value={inlineEdit?.title ?? ""}
          onChange={(event) => onInlineEditChange(event.target.value)}
          onKeyDown={(event) => handleInlineEditKeyDown(event, onInlineEditCommit, onInlineEditCancel)}
          onBlur={onInlineEditCancel}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.stopPropagation()}
          className="flex-1 border-ring"
        />
      ) : (
        <ThreadRowTitle thread={thread} presentation={presentation} />
      )}
      <ThreadProviderUnavailable thread={thread} isEditing={isEditing} presentation={presentation} />
      <ThreadCleanupStatus isEditing={isEditing} statusLabel={statusLabel} />
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

function ThreadRowTitle({ thread, presentation }: Pick<ThreadRowVisualProps, "thread" | "presentation">) {
  return (
    <>
      <span
        className={cn(
          "truncate flex-1",
          presentation.isUserCompleted && "text-muted-foreground/55 line-through decoration-muted-foreground/55 decoration-1",
          presentation.isStaleWorktree && "text-[var(--diff-remove-strong)]/85 line-through",
        )}
        data-testid="thread-title"
      >
        <StaleWorktreeWarning isStale={presentation.isStaleWorktree} />
        {thread.title}
      </span>
      <ThreadWorktreeIndicator thread={thread} />
    </>
  );
}

function StaleWorktreeWarning({ isStale }: { isStale: boolean }) {
  if (!isStale) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<AlertTriangle size={11} className="inline mr-1 align-text-bottom text-[var(--diff-remove-strong)]/80" />} />
      <TooltipContent side="right" className="text-xs">Worktree directory no longer exists</TooltipContent>
    </Tooltip>
  );
}

function ThreadWorktreeIndicator({ thread }: { thread: WorkspaceThread }) {
  if (thread.mode !== "worktree") return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<WorktreeModeIcon size={12} data-testid={`thread-worktree-indicator-${thread.id}`} aria-label="Worktree mode" className="text-muted-foreground/65" />} />
      <TooltipContent side="right" className="text-xs">Worktree</TooltipContent>
    </Tooltip>
  );
}

function ThreadProviderUnavailable({
  thread,
  isEditing,
  presentation,
}: Pick<ThreadRowVisualProps, "thread" | "isEditing" | "presentation">) {
  if (isEditing || !presentation.unusable) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span data-testid={`sidebar-unusable-${thread.id}`} className="ml-1 shrink-0 inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60" aria-label={presentation.unusableReason} />} />
      <TooltipContent side="right" className="text-xs">{presentation.unusableReason}</TooltipContent>
    </Tooltip>
  );
}

function ThreadCleanupStatus({ isEditing, statusLabel }: { isEditing: boolean; statusLabel: string | null }) {
  if (isEditing || !statusLabel) return null;
  return <span role="status" className="shrink-0 truncate text-xs text-muted-foreground">{statusLabel}</span>;
}

function ThreadCleanupRetry({
  thread,
  isEditing,
  cleanupBlocked,
  lifecycle,
}: Pick<ThreadRowVisualProps, "thread" | "isEditing" | "lifecycle"> & { cleanupBlocked: boolean }) {
  if (isEditing || !cleanupBlocked) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Retry cleanup for ${thread.title}`}
          disabled={lifecycle.isCleanupRetryPending}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={lifecycle.handleCleanupRetry}
          className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-transparent hover:text-foreground group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-visible:opacity-100"
        >
          {lifecycle.isCleanupRetryPending ? <Spinner size={12} /> : <RefreshCw size={13} aria-hidden />}
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">Retry cleanup</TooltipContent>
    </Tooltip>
  );
}

function ThreadPrStatus({
  thread,
  checks,
  isEditing,
  presentation,
}: Pick<ThreadRowVisualProps, "thread" | "checks" | "isEditing" | "presentation">) {
  if (isEditing || !isPrable(thread) || thread.pr_number === null) return null;
  return <ThreadPrIndicator threadId={thread.id} prNumber={thread.pr_number} prStatus={thread.pr_status} checks={checks} showCi={presentation.showPrCi} muted={presentation.isUserCompleted} />;
}

function ThreadEndMarker({ isEditing, presentation }: Pick<ThreadRowVisualProps, "isEditing" | "presentation">) {
  if (isEditing || !presentation.showEndMarker) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", presentation.isUserCompleted && "grayscale opacity-45")}>
      <ThreadStateMarker marker={presentation.marker} dim={Boolean(presentation.scaffoldDim)} />
    </span>
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
      <TooltipContent side="right" align="start" sideOffset={8} variant="surface" className="max-w-none p-3">
        <SidebarThreadPreview workspaceName={workspaceName} thread={thread} />
      </TooltipContent>
    </Tooltip>
  );
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
  threads: WorkspaceThread[];
  checksById: Record<string, ChecksStatus>;
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
              "text-[10px] font-medium tabular-nums leading-none",
              chromeClass,
            )}
          >
            {rollup.aggregate === "pending" ? (
              <Spinner size={9} className="text-current" />
            ) : (
              <Icon size={9} strokeWidth={CI_ICON_STROKE} className="shrink-0" />
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
  threads: WorkspaceThread[],
  checksById: Record<string, ChecksStatus>,
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

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const PROVIDER_META: Record<
  string,
  { icon: IconComponent; label: string; color: string }
> = {
  claude: { icon: ClaudeIcon, label: "Claude", color: "" },
  codex: { icon: CodexIcon, label: "Codex", color: "text-foreground" },
  copilot: {
    icon: CopilotIcon,
    label: "GitHub Copilot",
    color: "text-violet-400 dark:text-violet-300",
  },
  cursor: { icon: CursorProviderIcon, label: "Cursor", color: "" },
  devin: { icon: DevinIcon, label: "Devin", color: "" },
  gemini: { icon: GeminiIcon, label: "Gemini", color: "text-sky-400" },
  opencode: { icon: OpenCodeIcon, label: "OpenCode", color: "text-violet-400" },
};

function getProviderMeta(provider: string) {
  return (
    PROVIDER_META[provider] ?? {
      icon: Activity,
      label: provider || "Provider",
      color: "text-muted-foreground",
    }
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
      className="w-64 space-y-2 text-popover-foreground"
    >
      <div className="min-w-0 font-medium text-xs leading-5">
        {thread.title}
      </div>
      <div className="grid gap-1.5">
        <div className="text-xs text-muted-foreground">
          Updated {formatLifecycleDate(thread.updated_at)}
        </div>
        {thread.user_completed_at !== null ? (
          <>
            <div className="text-xs text-muted-foreground">
              Completed {formatLifecycleDate(thread.user_completed_at)}
            </div>
            {thread.cleanup_state === "blocked" ? (
              <div className="text-xs text-destructive" role="status">
                Cleanup blocked: {thread.cleanup_reason ?? "User action is required."}
              </div>
            ) : thread.cleanup_state === "queued" ? (
              <div className="text-xs text-muted-foreground" role="status">
                Cleanup queued
              </div>
            ) : thread.cleanup_state === "retrying" ? (
              <div className="text-xs text-muted-foreground" role="status">
                Retrying cleanup
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
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
          <Folder size={13} aria-hidden className="shrink-0 opacity-75" />
          <span className="truncate text-xs">{workspaceName}</span>
        </div>
        <div
          aria-label={`Branch, ${checkoutLabel}`}
          className="flex min-w-0 items-center gap-2"
        >
          <GitBranch size={13} aria-hidden className="shrink-0 opacity-75" />
          <span className="truncate font-mono text-xs">{checkoutLabel}</span>
        </div>
      </div>
    </div>
  );
}

interface ThreadPrIndicatorProps {
  threadId: string;
  prNumber: number;
  prStatus: string | null;
  checks: ChecksStatus | undefined;
  showCi: boolean;
  muted?: boolean;
}

function formatLifecycleDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function threadCountLabel(
  count: number,
  state: "active" | "completed",
): string {
  return `${count} ${state} ${count === 1 ? "thread" : "threads"}`;
}

/** Renders an optically aligned PR glyph with its CI state attached as a status dot. */
const ThreadPrIndicator = memo(function ThreadPrIndicator({
  threadId,
  prNumber,
  prStatus,
  checks,
  showCi,
  muted = false,
}: ThreadPrIndicatorProps) {
  const { Icon: PrIcon, color: prColor } = getPrVisual(prStatus);
  const ciVisual = threadPrCiVisual(showCi, checks);
  const label = `PR #${prNumber}, ${prStatus ?? "open"}${ciVisual ? `. ${ciVisual.label}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            data-testid={`thread-pr-indicator-${threadId}`}
            className={cn(
              "-mt-px flex h-4 w-4 items-center justify-center",
              muted && "grayscale opacity-45",
            )}
          >
            <span className="relative flex size-4 items-center justify-center">
              <PrIcon
                size={13}
                aria-hidden
                className={cn("shrink-0", prColor)}
              />
              {ciVisual ? (
                <span
                  data-testid={`thread-pr-ci-${threadId}`}
                  aria-hidden
                  className={cn(
                    "absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-current ring-1 ring-page",
                    ciVisual.color,
                    checks?.aggregate === "pending" && "status-pulse",
                  )}
                />
              ) : null}
            </span>
          </span>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});

function threadPrCiVisual(showCi: boolean, checks: ChecksStatus | undefined) {
  if (!showCi || !checks || checks.aggregate === "no_checks") return null;
  return getCiVisual(checks.aggregate);
}

/** Thread counts and capped tree rows for one workspace's lifecycle view. */
interface ThreadListSummary {
  activeThreadCount: number;
  completedThreadCount: number;
  visibleThreads: WorkspaceThread[];
  treeItems: ThreadTreeItem[];
  needsCap: boolean;
  forceExpand: boolean;
  maxVisible: number;
}

/** Computes the thread list summary; tree items are only built when expanded. */
function computeThreadListSummary(
  threads: WorkspaceThread[],
  lifecycleView: ProjectLifecycleView,
  isThreadListExpanded: boolean,
  activeThreadId: string | null,
  isWorkspaceExpanded: boolean,
): ThreadListSummary {
  const activeThreadCount = threads.filter(
    (thread) => thread.user_completed_at === null,
  ).length;
  const visibleThreads = threads.filter((thread) =>
    isVisibleInLifecycleView(thread, lifecycleView),
  );
  const treeItems = isWorkspaceExpanded
    ? buildThreadTree(visibleThreads)
    : [];
  const needsCap = treeItems.length > THREAD_LIST_CAP;
  const forceExpand = activeThreadNeedsExpansion(activeThreadId, treeItems);
  return {
    activeThreadCount,
    completedThreadCount: threads.length - activeThreadCount,
    visibleThreads,
    treeItems,
    needsCap,
    forceExpand,
    maxVisible: !needsCap || isThreadListExpanded || forceExpand ? Infinity : THREAD_LIST_CAP,
  };
}

function isVisibleInLifecycleView(
  thread: WorkspaceThread,
  lifecycleView: ProjectLifecycleView,
): boolean {
  return lifecycleView === "completed"
    ? thread.user_completed_at !== null
    : thread.user_completed_at === null;
}

function activeThreadNeedsExpansion(
  activeThreadId: string | null,
  treeItems: ThreadTreeItem[],
): boolean {
  if (!activeThreadId) return false;
  return treeItems.findIndex((item) => item.thread.id === activeThreadId) >= THREAD_LIST_CAP;
}

interface ProjectWorkspaceRowProps {
  workspace: Workspace;
  isExpanded: boolean;
  isActive: boolean;
  isProjectDragging: boolean;
  sortableListeners: DraggableSyntheticListeners | undefined;
  sortableAttributes: SortableAttributes | undefined;
  lifecycleView: ProjectLifecycleView;
  checksById: Record<string, ChecksStatus>;
  hasRunning: boolean;
  threadList: ThreadListSummary;
  onToggle: (wsId: string) => void;
  onToggleLifecycleView: (workspaceId: string) => void;
  onCreateThread: (wsId: string) => void;
  onDelete: (wsId: string) => void;
  onRename: (workspace: Workspace) => void;
}

function ProjectWorkspaceRow({
  workspace,
  isExpanded,
  isActive,
  isProjectDragging,
  sortableListeners,
  sortableAttributes,
  lifecycleView,
  checksById,
  hasRunning,
  threadList,
  onToggle,
  onToggleLifecycleView,
  onCreateThread,
  onDelete,
  onRename,
}: ProjectWorkspaceRowProps) {
  const lifecycle = projectLifecycleSummary(workspace, lifecycleView, threadList);
  const toggle = useCallback(() => onToggle(workspace.id), [onToggle, workspace.id]);
  const selectLifecycleView = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onToggleLifecycleView(workspace.id);
  }, [onToggleLifecycleView, workspace.id]);
  const createThread = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onCreateThread(workspace.id);
  }, [onCreateThread, workspace.id]);
  const deleteProject = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onDelete(workspace.id);
  }, [onDelete, workspace.id]);
  const renameProject = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onRename(workspace);
  }, [onRename, workspace]);
  const openInExplorer = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void getTransport().openIn(FILE_EXPLORER_ID, workspace.path).catch((error: unknown) => {
      useToastStore.getState().show(
        "error",
        "Couldn't open File Explorer",
        String((error as { message?: string })?.message ?? error),
      );
    });
  }, [workspace.path]);
  return (
    <div
      // The sortable metadata (roledescription, keyboard-instructions ref)
      // must sit on the focusable activator, not an unfocusable wrapper, or
      // screen readers never announce the drag affordance. role stays "group"
      // because the row contains nested buttons; the DragOverlay clone gets no
      // sortable attributes and drops out of the tab order.
      {...groupRowSortableAttributes(sortableAttributes)}
      role="group"
      tabIndex={sortableAttributes ? 0 : -1}
      aria-label={lifecycle.projectLabel}
      data-testid={`project-row-${workspace.id}`}
      onClick={toggle}
      className={cn(
        "group/ws relative flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        isProjectDragging && "cursor-grabbing",
        isActive ? "text-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
      {...sortableListeners}
    >
      <ProjectLifecycleToggle lifecycle={lifecycle} lifecycleView={lifecycleView} onClick={selectLifecycleView} />
      <ProjectTitle workspace={workspace} onClick={toggle} />
      <ProjectGitStatus isGitRepository={workspace.is_git_repo} />
      <WorkspaceCiRollupChip threads={threadList.visibleThreads} checksById={checksById} />
      <ProjectRunningStatus hasRunning={hasRunning} />
      <ProjectThreadCount workspaceId={workspace.id} count={threadList.visibleThreads.length} />
      <ProjectRowActions
        workspace={workspace}
        isExpanded={isExpanded}
        onToggle={toggle}
        onOpenInExplorer={openInExplorer}
        onRename={renameProject}
        onDelete={deleteProject}
        onCreateThread={createThread}
      />
    </div>
  );
}

function projectLifecycleSummary(
  workspace: Workspace,
  lifecycleView: ProjectLifecycleView,
  threadList: ThreadListSummary,
) {
  const destination = lifecycleView === "active" ? "completed" : "active";
  const destinationCount = destination === "completed"
    ? threadList.completedThreadCount
    : threadList.activeThreadCount;
  return {
    label: `View ${threadCountLabel(destinationCount, destination)} for ${workspace.name}`,
    projectLabel: `${workspace.name} project, ${lifecycleView} view, ${threadCountLabel(threadList.activeThreadCount, "active")}, ${threadCountLabel(threadList.completedThreadCount, "completed")}`,
  };
}

function ProjectLifecycleToggle({
  lifecycle,
  lifecycleView,
  onClick,
}: { lifecycle: ReturnType<typeof projectLifecycleSummary>; lifecycleView: ProjectLifecycleView; onClick: (event: React.MouseEvent) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={lifecycle.label}
          aria-pressed={lifecycleView === "completed"}
          data-view={lifecycleView}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={onClick}
          className="relative -m-1.5 mr-0 size-8 shrink-0 rounded-sm text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
        >
          <ProjectLifecycleIcons lifecycleView={lifecycleView} />
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">{lifecycle.label}</TooltipContent>
    </Tooltip>
  );
}

function ProjectLifecycleIcons({ lifecycleView }: { lifecycleView: ProjectLifecycleView }) {
  if (lifecycleView === "completed") {
    return <><FolderCheck size={14} className="transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none" aria-hidden /><FolderOpen size={14} className="absolute opacity-0 transition-opacity duration-150 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 motion-reduce:transition-none" aria-hidden /></>;
  }
  return <><FolderOpen size={14} className="transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none" aria-hidden /><FolderCheck size={14} className="absolute opacity-0 transition-opacity duration-150 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 motion-reduce:transition-none" aria-hidden /></>;
}

function ProjectTitle({ workspace, onClick }: { workspace: Workspace; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button type="button" variant="ghost" size="xs" aria-label={`Open project ${workspace.name}`} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClick(); }} className="h-auto min-w-0 flex-1 shrink justify-start rounded-sm p-0 text-left hover:bg-transparent group-hover/ws:pr-24 group-focus-within/ws:pr-24 dark:hover:bg-transparent">
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-medium tracking-tight group-hover/ws:[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] group-focus-within/ws:[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] group-hover/ws:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] group-focus-within/ws:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]">{workspace.name}</span>
        </Button>
      } />
      <TooltipContent side="right" className="text-xs">{workspace.name}</TooltipContent>
    </Tooltip>
  );
}

function ProjectGitStatus({ isGitRepository }: { isGitRepository: boolean }) {
  if (isGitRepository) return null;
  return <Tooltip><TooltipTrigger render={<GitBranchMinus size={12} strokeWidth={2} className="shrink-0 text-muted-foreground/45" aria-label="Not a git repository" />} /><TooltipContent side="right" className="text-xs">Not a git repository</TooltipContent></Tooltip>;
}

function ProjectRunningStatus({ hasRunning }: { hasRunning: boolean }) {
  if (!hasRunning) return null;
  return <Tooltip><TooltipTrigger render={<span aria-hidden="true" className="shrink-0 h-1.5 w-1.5 rounded-full bg-primary status-pulse transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none" />} /><TooltipContent side="right" className="text-xs">Active agent in this project</TooltipContent></Tooltip>;
}

function ProjectThreadCount({ workspaceId, count }: { workspaceId: string; count: number }) {
  if (count === 0) return null;
  return <span data-testid={`project-thread-count-${workspaceId}`} className="ml-auto flex h-4 min-w-3 shrink-0 items-center justify-end font-mono text-xs leading-4 tabular-nums text-muted-foreground/45 transition-opacity duration-150 group-hover/ws:opacity-0 group-focus-within/ws:opacity-0 motion-reduce:transition-none">{count}</span>;
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
    <div data-testid={`project-row-actions-${workspace.id}`} className="pointer-events-none absolute inset-y-0 right-1.5 z-10 flex items-center justify-end gap-1 bg-transparent px-0.5 opacity-0 transition-opacity duration-150 group-hover/ws:pointer-events-auto group-hover/ws:opacity-100 group-focus-within/ws:pointer-events-auto group-focus-within/ws:opacity-100 motion-reduce:transition-none">
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Toggle threads for ${workspace.name}`} aria-expanded={isExpanded} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggle(); }} className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-transparent hover:text-muted-foreground dark:hover:bg-transparent group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 focus:opacity-100">
        <ChevronRight size={14} className={cn("transition-transform duration-150 motion-reduce:transition-none", isExpanded && "rotate-90")} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`Project options for ${workspace.name}`} onClick={(event) => event.stopPropagation()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-colors hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100"><MoreHorizontal size={13} /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
          <DropdownMenuItem onClick={onOpenInExplorer} className="flex cursor-pointer items-center gap-2"><FolderOpen size={13} />Open in Explorer</DropdownMenuItem>
          <DropdownMenuItem onClick={onRename} className="flex cursor-pointer items-center gap-2"><Pencil size={13} />Rename project</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} className="flex cursor-pointer items-center gap-2 text-destructive focus:text-destructive"><Trash2 size={13} />Delete project</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-xs" aria-label={`New thread in ${workspace.name}`} onKeyDown={(event) => event.stopPropagation()} onClick={onCreateThread} className="opacity-0 text-muted-foreground hover:bg-background/60 hover:text-foreground group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 focus:opacity-100"><SquarePen className="size-[1.4rem]" /></Button>}
        />
        <TooltipContent>{`New thread in ${workspace.name}`}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ProjectThreadListToggle({
  workspaceId,
  isExpanded,
  hiddenCount,
  onToggleThreadList,
}: { workspaceId: string; isExpanded: boolean; hiddenCount: number; onToggleThreadList: (workspaceId: string) => void }) {
  const label = isExpanded ? "Show less" : `Show more (${hiddenCount})`;
  return <Button variant="ghost" size="xs" onClick={() => onToggleThreadList(workspaceId)} className="mt-0.5 h-auto w-full justify-start rounded-md px-2 py-1 text-[11px] font-normal text-muted-foreground/55 hover:bg-accent/40 hover:text-foreground">{label}</Button>;
}

/**
 * Shared render deps for every project group row, bundled so the render
 * callback stays a single prop change when any handler or store slice updates.
 */
interface ProjectTreeRowContext {
  readonly checksById: Record<string, ChecksStatus>;
  readonly pendingPermissionThreadIds: ReadonlySet<string>;
  readonly inlineEdit: InlineEditState | null;
  readonly worktreesLoadedFor: string | null;
  readonly validWorktreePaths: Set<string>;
  readonly availableProviders: Array<{
    id: string;
    enabled: boolean;
    cli: { status: string };
  }>;
  onToggle: (wsId: string) => void;
  onToggleLifecycleView: (wsId: string) => void;
  onCreateThread: (wsId: string) => void;
  onDelete: (wsId: string) => void;
  onRename: (workspace: Workspace) => void;
  onToggleThreadList: (wsId: string) => void;
  onInlineEditChange: (title: string) => void;
  onInlineEditCommit: () => void;
  onInlineEditCancel: () => void;
  onThreadClick: (wsId: string, threadId: string) => void;
  onThreadDoubleClick: (threadId: string) => void;
  onSelectThread: (wsId: string, threadId: string) => void;
  onThreadContextMenu: (
    event: React.MouseEvent,
    thread: Thread,
    workspacePath: string,
  ) => void;
  onCompleteThread: (threadId: string) => Promise<void>;
  onReopenThread: (threadId: string) => Promise<void>;
  onRetryThreadCleanup: (threadId: string) => Promise<void>;
  onOpenDraft: (wsId: string, draftId: string) => void;
  onDiscardDraft: (draftId: string) => void;
  onDraftContextMenu: (event: React.MouseEvent, draftId: string) => void;
  readonly dropIndicator: {
    readonly id: string;
    readonly edge: "top" | "bottom";
  } | null;
}

/**
 * Pointer-following clone of the dragged project group. The virtualizer may
 * unmount the real row when auto-scroll moves its slot outside the render
 * window, so the drag visual lives in an overlay.
 */
function ProjectTreeDragOverlay({
  row,
  ctx,
}: {
  row: ProjectTreeRowData | undefined;
  ctx: ProjectTreeRowContext;
}) {
  return (
    <DragOverlay>
      {row ? (
        <div className="px-1.5 pb-1">
          <WorkspaceGroup
            row={row}
            ctx={ctx}
            sortableListeners={undefined}
            sortableAttributes={undefined}
          />
        </div>
      ) : null}
    </DragOverlay>
  );
}

type SortableAttributes = ReturnType<typeof useSortable>["attributes"];

/** Sortable metadata safe for the focusable group row: role/tabIndex are set
 * explicitly and aria-pressed/aria-disabled are only valid on buttons. */
function groupRowSortableAttributes(attributes: SortableAttributes | undefined) {
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

/** Applies sortable positioning to a project group in the virtual list. */
const SortableProjectRow = memo(function SortableProjectRow({
  row,
  ctx,
}: {
  row: ProjectTreeRowData;
  ctx: ProjectTreeRowContext;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.workspace.id,
  });
  const style: CSSProperties = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    transition,
    ...(isDragging ? { opacity: 0.35, zIndex: 2 } : {}),
  };
  const indicatorEdge =
    ctx.dropIndicator?.id === row.workspace.id ? ctx.dropIndicator.edge : null;
  return (
    <div ref={setNodeRef} style={style} className="relative">
      {indicatorEdge !== null && (
        <div
          data-testid="drop-indicator"
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 z-10 h-1 rounded-full bg-primary",
            indicatorEdge === "top" ? "top-0" : "bottom-0",
          )}
        />
      )}
      <WorkspaceGroup
        row={row}
        ctx={ctx}
        isDragging={isDragging}
        sortableListeners={listeners}
        sortableAttributes={attributes}
      />
    </div>
  );
});

/** One project group: the workspace header plus its expanded thread section. */
function WorkspaceGroup({
  row,
  ctx,
  isDragging = false,
  sortableListeners,
  sortableAttributes,
}: {
  row: ProjectTreeRowData;
  ctx: ProjectTreeRowContext;
  isDragging?: boolean;
  sortableListeners: DraggableSyntheticListeners | undefined;
  sortableAttributes: SortableAttributes | undefined;
}) {
  return (
    <>
      <ProjectWorkspaceRow
        workspace={row.workspace}
        isExpanded={row.isExpanded}
        isActive={row.isActive}
        isProjectDragging={isDragging}
        sortableListeners={sortableListeners}
        sortableAttributes={sortableAttributes}
        lifecycleView={row.lifecycleView}
        threadList={row.threadList}
        checksById={ctx.checksById}
        hasRunning={row.hasRunning}
        onToggle={ctx.onToggle}
        onToggleLifecycleView={ctx.onToggleLifecycleView}
        onCreateThread={ctx.onCreateThread}
        onDelete={ctx.onDelete}
        onRename={ctx.onRename}
      />
      {row.isExpanded && <WorkspaceThreadSection row={row} ctx={ctx} />}
    </>
  );
}

/** Row for a local unsent new-thread draft; mirrors thread-row chrome minus
 * provider and lifecycle affordances so it never reads as a real thread. */
function DraftRow({
  workspaceId,
  draft,
  isActive,
  onOpen,
  onDiscard,
  onContextMenu,
}: {
  workspaceId: string;
  draft: ThreadDraft;
  isActive: boolean;
  onOpen: (workspaceId: string, draftId: string) => void;
  onDiscard: (draftId: string) => void;
  onContextMenu: (event: React.MouseEvent, draftId: string) => void;
}) {
  const firstLine = draft.draft.input.split("\n")[0]?.trim() ?? "";
  const attachmentCount = draft.draft.attachments.length;
  const preview = firstLine
    || (attachmentCount > 0
      ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
      : "Empty draft");
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (!isThreadRowNavigationEvent(event)) return;
        event.preventDefault();
        onOpen(workspaceId, draft.id);
      }}
      onClick={() => onOpen(workspaceId, draft.id)}
      onContextMenu={(event) => onContextMenu(event, draft.id)}
      className={cn(
        "group/row relative flex min-h-8 items-center gap-2 rounded-md pr-2 text-[13px] cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground/70 hover:bg-accent/40 hover:text-foreground",
      )}
      style={{ paddingLeft: "46px" }}
    >
      <span
        className="absolute left-0.5 top-1/2 flex -translate-y-1/2 items-center justify-end gap-1"
        style={{ width: "40px" }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Delete draft"
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard(draft.id);
                }}
                className="size-5 shrink-0 rounded-full p-0 text-muted-foreground/65 opacity-0 transition-opacity shadow-none hover:bg-transparent hover:text-foreground group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 size={12} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="right" className="text-xs">
            Delete draft
          </TooltipContent>
        </Tooltip>
        <span className="-mt-px flex h-4 w-4 items-center justify-center text-muted-foreground/45">
          <Pencil size={12} aria-hidden />
        </span>
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground/60">
          Draft
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/75">
          {preview}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground/50">
          {formatRelative(new Date(draft.updatedAt).toISOString())}
        </span>
      </div>
    </div>
  );
}

/** The expanded section under a workspace header: draft rows, empty note,
 * capped thread rows, and the show-more toggle. */
function WorkspaceThreadSection({
  row,
  ctx,
}: {
  row: ProjectTreeRowData;
  ctx: ProjectTreeRowContext;
}) {
  const { workspace, threadList, lifecycleView, isThreadListExpanded, drafts } = row;
  const capped = Number.isFinite(threadList.maxVisible)
    ? threadList.treeItems.slice(0, threadList.maxVisible)
    : threadList.treeItems;
  const showDrafts = lifecycleView === "active" && drafts.length > 0;
  return (
    <>
      {showDrafts &&
        drafts.map((draft) => (
          <div
            key={draft.id}
            data-testid="draft-item"
            data-draft-id={draft.id}
          >
            <DraftRow
              workspaceId={workspace.id}
              draft={draft}
              isActive={row.activeDraftId === draft.id}
              onOpen={ctx.onOpenDraft}
              onDiscard={ctx.onDiscardDraft}
              onContextMenu={ctx.onDraftContextMenu}
            />
          </div>
        ))}
      {threadList.visibleThreads.length === 0 && !showDrafts ? (
        <p
          data-testid={`project-empty-${workspace.id}`}
          className="px-9 py-1 font-mono text-xs text-muted-foreground/70"
        >
          {lifecycleView === "completed"
            ? "No completed threads"
            : "No active threads"}
        </p>
      ) : (
        capped.map((item) => (
          <div
            key={item.thread.id}
            data-testid="thread-item"
            data-thread-id={item.thread.id}
          >
            <ThreadRow
              workspaceName={workspace.name}
              thread={item.thread}
              depth={item.depth}
              hasPendingPermission={ctx.pendingPermissionThreadIds.has(
                item.thread.id,
              )}
              checks={ctx.checksById[item.thread.id]}
              isEditing={ctx.inlineEdit?.threadId === item.thread.id}
              inlineEdit={
                ctx.inlineEdit?.threadId === item.thread.id
                  ? ctx.inlineEdit
                  : null
              }
              worktreesLoadedFor={ctx.worktreesLoadedFor}
              validWorktreePaths={ctx.validWorktreePaths}
              availableProviders={ctx.availableProviders}
              onInlineEditChange={ctx.onInlineEditChange}
              onInlineEditCommit={ctx.onInlineEditCommit}
              onInlineEditCancel={ctx.onInlineEditCancel}
              onThreadClick={(threadId) =>
                ctx.onThreadClick(workspace.id, threadId)
              }
              onThreadDoubleClick={ctx.onThreadDoubleClick}
              onSelectThread={(threadId) =>
                ctx.onSelectThread(workspace.id, threadId)
              }
              onThreadContextMenu={(event, clicked) =>
                ctx.onThreadContextMenu(event, clicked, workspace.path)
              }
              onCompleteThread={ctx.onCompleteThread}
              onReopenThread={ctx.onReopenThread}
              onRetryThreadCleanup={ctx.onRetryThreadCleanup}
            />
          </div>
        ))
      )}
      {threadList.needsCap && !threadList.forceExpand && (
        <ProjectThreadListToggle
          workspaceId={workspace.id}
          isExpanded={isThreadListExpanded}
          hiddenCount={threadList.treeItems.length - THREAD_LIST_CAP}
          onToggleThreadList={ctx.onToggleThreadList}
        />
      )}
    </>
  );
}
