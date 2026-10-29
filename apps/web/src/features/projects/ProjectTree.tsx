import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GitBranch, GitMerge } from "lucide-react";
import { effectiveAutoCompleteOnMerge } from "@mcode/contracts/models/thread";
import { ContextMenu, type SwitchMenuItem } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";
import type { Thread, Workspace } from "@/transport/types";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useSidebarUiStore } from "./sidebar/sidebar-ui-store";
import type { InlineEditState, SidebarRowContext } from "./sidebar/sidebar-row-context";
import { rpcFailureMessage } from "@/transport/rpc-failure-message";

/** Time window in ms during which a second click on the same thread row is treated as a double-click. */
const DOUBLE_CLICK_THRESHOLD_MS = 250;

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

/** A project named in the delete or rename dialog. */
interface WorkspaceDialogState {
  workspaceId: string;
  workspaceName: string;
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

function findThread(threadId: string): WorkspaceThread | undefined {
  return useWorkspaceStore.getState().threads.find((thread) => thread.id === threadId);
}

function editStateFor(thread: WorkspaceThread): InlineEditState {
  return { threadId: thread.id, title: thread.title, originalTitle: thread.title };
}

function useLoadActiveWorkspaceWorktrees(): void {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadedFor = useWorkspaceStore((s) => s.worktreesLoadedForWorkspace);
  const loadWorktrees = useWorkspaceStore((s) => s.loadWorktrees);
  const needsWorktrees = useWorkspaceStore((s) => activeWorkspaceId !== null && s.threads.some(
    (thread) => thread.workspace_id === activeWorkspaceId && thread.mode === "worktree" && Boolean(thread.worktree_path),
  ));
  useEffect(() => {
    if (!activeWorkspaceId || loadedFor === activeWorkspaceId || !needsWorktrees) return;
    void loadWorktrees(activeWorkspaceId);
  }, [activeWorkspaceId, loadedFor, needsWorktrees, loadWorktrees]);
}

/** Inline rename: F2 on the active thread, double-click, commit and cancel. */
function useInlineRename() {
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const inlineEditRef = useRef(inlineEdit);
  useEffect(() => {
    inlineEditRef.current = inlineEdit;
  });
  const updateThreadTitle = useWorkspaceStore((s) => s.updateThreadTitle);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F2" || inlineEditRef.current || isEditableKeyboardTarget(event.target)) return;
      const activeThreadId = useWorkspaceStore.getState().activeThreadId;
      const thread = activeThreadId ? findThread(activeThreadId) : undefined;
      if (!thread) return;
      event.preventDefault();
      setInlineEdit(editStateFor(thread));
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const start = useCallback((threadId: string) => {
    const thread = findThread(threadId);
    if (thread) setInlineEdit(editStateFor(thread));
  }, []);
  const change = useCallback((title: string) => setInlineEdit((prev) => (prev ? { ...prev, title } : null)), []);
  const cancel = useCallback(() => setInlineEdit(null), []);
  const commit = useCallback(async () => {
    const edit = inlineEditRef.current;
    if (!edit) return;
    const title = edit.title.trim();
    if (!title || title === edit.originalTitle) {
      setInlineEdit(null);
      return;
    }
    try {
      await updateThreadTitle(edit.threadId, title);
      setInlineEdit(null);
    } catch {
      // Error surfaced via store.error; keep editor open so user can retry
    }
  }, [updateThreadTitle]);
  return { inlineEdit, inlineEditRef, setInlineEdit, start, change, cancel, commit };
}

/** Single click navigates at once; a second click within the window starts a rename instead. */
function useThreadClicks(rename: ReturnType<typeof useInlineRename>) {
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const lastClickTimeRef = useRef<Map<string, number>>(new Map());
  const { inlineEditRef, start } = rename;
  const select = useCallback((workspaceId: string, threadId: string) => {
    setActiveWorkspace(workspaceId);
    setActiveThread(threadId);
  }, [setActiveWorkspace, setActiveThread]);
  const click = useCallback((workspaceId: string, threadId: string) => {
    // If already editing this thread, clicks are absorbed to avoid conflicting with the input.
    if (inlineEditRef.current?.threadId === threadId) return;
    const now = Date.now();
    const last = lastClickTimeRef.current.get(threadId);
    lastClickTimeRef.current.set(threadId, now);
    if (last !== undefined && now - last < DOUBLE_CLICK_THRESHOLD_MS) {
      // The first click has already navigated, so the rename happens in place on the active row.
      lastClickTimeRef.current.delete(threadId);
      start(threadId);
      return;
    }
    select(workspaceId, threadId);
  }, [inlineEditRef, start, select]);
  const doubleClick = useCallback((threadId: string) => {
    if (inlineEditRef.current?.threadId === threadId) return;
    lastClickTimeRef.current.delete(threadId);
    start(threadId);
  }, [inlineEditRef, start]);
  return { select, click, doubleClick };
}

function useThreadDeletion() {
  const deleteThread = useWorkspaceStore((s) => s.deleteThread);
  const [dialog, setDialog] = useState<DeleteDialogState | null>(null);
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const open = useCallback((state: DeleteDialogState) => {
    setDialog(state);
    setDeleteWorktree(false);
  }, []);
  const close = useCallback(() => {
    setDialog(null);
    setDeleteWorktree(false);
  }, []);
  const confirm = useCallback(async () => {
    if (!dialog || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteThread(dialog.threadId, deleteWorktree);
      close();
    } catch {
      // Error shown via store.error; keep dialog open so user can retry
    } finally {
      setIsDeleting(false);
    }
  }, [dialog, deleteWorktree, deleteThread, isDeleting, close]);
  return { dialog, deleteWorktree, setDeleteWorktree, isDeleting, open, close, confirm };
}

function useProjectDialogs() {
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const [deleteDialog, setDeleteDialog] = useState<WorkspaceDialogState | null>(null);
  const [renameDialog, setRenameDialog] = useState<WorkspaceDialogState | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const openDelete = useCallback((workspaceId: string) => {
    const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace) setDeleteDialog({ workspaceId: workspace.id, workspaceName: workspace.name });
  }, []);
  const openRename = useCallback((workspace: Workspace) => {
    setRenameValue(workspace.name);
    setRenameDialog({ workspaceId: workspace.id, workspaceName: workspace.name });
  }, []);
  const confirmDelete = useCallback(async () => {
    if (!deleteDialog) return;
    try {
      await deleteWorkspace(deleteDialog.workspaceId);
      setDeleteDialog(null);
    } catch {
      // Error shown via store.error; keep dialog open so user can retry
    }
  }, [deleteDialog, deleteWorkspace]);
  const confirmRename = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!renameDialog || isRenaming) return;
    const name = renameValue.trim();
    if (!name || name === renameDialog.workspaceName) {
      setRenameDialog(null);
      return;
    }
    setIsRenaming(true);
    try {
      await renameWorkspace(renameDialog.workspaceId, name);
      setRenameDialog(null);
    } catch {
      // The workspace store retains the failure message for the sidebar error rail.
    } finally {
      setIsRenaming(false);
    }
  }, [isRenaming, renameWorkspace, renameValue, renameDialog]);
  return { deleteDialog, setDeleteDialog, renameDialog, setRenameDialog, renameValue, setRenameValue, isRenaming, openDelete, openRename, confirmDelete, confirmRename };
}

function useMenus() {
  const [threadMenu, setThreadMenu] = useState<ContextMenuState | null>(null);
  const [draftMenu, setDraftMenu] = useState<DraftContextMenuState | null>(null);
  const openThreadMenu = useCallback((event: React.MouseEvent, thread: Thread, workspacePath: string) => {
    event.preventDefault();
    setThreadMenu({ x: event.clientX, y: event.clientY, threadId: thread.id, threadTitle: thread.title, workspacePath, worktreePath: thread.worktree_path });
  }, []);
  const openDraftMenu = useCallback((event: React.MouseEvent, draftId: string) => {
    event.preventDefault();
    setDraftMenu({ x: event.clientX, y: event.clientY, draftId });
  }, []);
  return { threadMenu, setThreadMenu, draftMenu, setDraftMenu, openThreadMenu, openDraftMenu };
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function useRowFacts() {
  const worktreesLoadedFor = useWorkspaceStore((s) => s.worktreesLoadedForWorkspace);
  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const availableProviders = useProviderAvailabilityStore((s) => s.providers);
  const validWorktreePaths = useMemo(() => new Set(worktrees.map((worktree) => normalizedPath(worktree.path))), [worktrees]);
  return { worktreesLoadedFor, validWorktreePaths, availableProviders };
}

function useThreadAndDraftActions() {
  const setPrimarySurface = useUiStore((s) => s.setPrimarySurface);
  const beginNewThread = useWorkspaceStore((s) => s.beginNewThread);
  const openThreadDraft = useWorkspaceStore((s) => s.openThreadDraft);
  const discardThreadDraft = useWorkspaceStore((s) => s.discardThreadDraft);
  const createThread = useCallback((workspaceId: string) => {
    setPrimarySurface("chat");
    beginNewThread(workspaceId);
  }, [beginNewThread, setPrimarySurface]);
  const openDraft = useCallback((workspaceId: string, draftId: string) => {
    setPrimarySurface("chat");
    openThreadDraft(workspaceId, draftId);
  }, [openThreadDraft, setPrimarySurface]);
  return { createThread, openDraft, discardDraft: discardThreadDraft };
}

/**
 * The sidebar's menus and dialogs and the row context that opens them. Handlers read thread
 * data at call time, so the context stays stable across thread pushes and rows skip rendering.
 */
export function useProjectTreeMenus(): { ctx: SidebarRowContext; overlays: ReactNode } {
  const rename = useInlineRename();
  const clicks = useThreadClicks(rename);
  const deletion = useThreadDeletion();
  const projects = useProjectDialogs();
  const menus = useMenus();
  const facts = useRowFacts();
  const actions = useThreadAndDraftActions();
  const toggleProject = useSidebarUiStore((s) => s.toggleProject);
  const toggleShowMore = useSidebarUiStore((s) => s.toggleShowMore);
  const reopenThread = useWorkspaceStore((s) => s.reopenThread);
  const retryThreadCleanup = useWorkspaceStore((s) => s.retryThreadCleanup);
  useLoadActiveWorkspaceWorktrees();

  const { worktreesLoadedFor, validWorktreePaths, availableProviders } = facts;
  const ctx = useMemo<SidebarRowContext>(() => ({
    worktreesLoadedFor,
    validWorktreePaths,
    availableProviders,
    inlineEdit: rename.inlineEdit,
    onToggleProject: toggleProject,
    onToggleShowMore: toggleShowMore,
    onCreateThread: actions.createThread,
    onDeleteProject: projects.openDelete,
    onRenameProject: projects.openRename,
    onInlineEditChange: rename.change,
    onInlineEditCommit: rename.commit,
    onInlineEditCancel: rename.cancel,
    onThreadClick: clicks.click,
    onThreadDoubleClick: clicks.doubleClick,
    onSelectThread: clicks.select,
    onThreadContextMenu: menus.openThreadMenu,
    onReopenThread: reopenThread,
    onRetryThreadCleanup: retryThreadCleanup,
    onOpenDraft: actions.openDraft,
    onDiscardDraft: actions.discardDraft,
    onDraftContextMenu: menus.openDraftMenu,
  }), [
    worktreesLoadedFor, validWorktreePaths, availableProviders,
    rename.inlineEdit, rename.change, rename.commit, rename.cancel,
    toggleProject, toggleShowMore, actions.createThread, actions.openDraft, actions.discardDraft,
    projects.openDelete, projects.openRename, clicks.click, clicks.doubleClick, clicks.select,
    menus.openThreadMenu, menus.openDraftMenu, reopenThread, retryThreadCleanup,
  ]);

  const overlays = (
    <>
      <ThreadContextMenuOverlay
        contextMenu={menus.threadMenu}
        onClose={() => menus.setThreadMenu(null)}
        onStartRename={rename.setInlineEdit}
        onDeleteThread={deletion.open}
      />
      <DraftContextMenuOverlay contextMenu={menus.draftMenu} onClose={() => menus.setDraftMenu(null)} onDeleteDraft={actions.discardDraft} />
      <ThreadDeleteDialog
        dialog={deletion.dialog}
        deleteWorktree={deletion.deleteWorktree}
        isDeleting={deletion.isDeleting}
        onDeleteWorktreeChange={deletion.setDeleteWorktree}
        onClose={deletion.close}
        onConfirm={deletion.confirm}
      />
      <WorkspaceDeleteDialog dialog={projects.deleteDialog} onClose={() => projects.setDeleteDialog(null)} onConfirm={projects.confirmDelete} />
      <WorkspaceRenameDialog
        dialog={projects.renameDialog}
        value={projects.renameValue}
        isRenaming={projects.isRenaming}
        onChange={projects.setRenameValue}
        onClose={() => projects.setRenameDialog(null)}
        onSubmit={projects.confirmRename}
      />
    </>
  );
  return { ctx, overlays };
}

function WorkspaceDeleteDialog({ dialog, onClose, onConfirm }: { dialog: WorkspaceDialogState | null; onClose: () => void; onConfirm: () => Promise<void> }) {
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md overflow-hidden">
        <div className="flex flex-col gap-2">
          <DialogTitle>Delete project</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &ldquo;{dialog?.workspaceName}&rdquo;? All threads in this project will also be removed. This action cannot be undone.
          </DialogDescription>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>Delete</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface WorkspaceRenameDialogProps {
  dialog: WorkspaceDialogState | null;
  value: string;
  isRenaming: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => Promise<void>;
}

function WorkspaceRenameDialog({ dialog, value, isRenaming, onChange, onClose, onSubmit }: WorkspaceRenameDialogProps) {
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !isRenaming) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md overflow-hidden">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>Choose a new name for {dialog?.workspaceName}.</DialogDescription>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workspace-rename">Project name</Label>
            <Input id="workspace-rename" value={value} onChange={(event) => onChange(event.target.value)} maxLength={120} autoFocus disabled={isRenaming} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={isRenaming} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isRenaming || value.trim().length === 0}>
              {isRenaming && <Spinner size={16} className="text-current" />}
              {isRenaming ? "Renaming..." : "Rename"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function useAutoCompleteSwitch(threadId: string | null): SwitchMenuItem | null {
  const thread = useWorkspaceStore((s) => (threadId === null ? undefined : s.threads.find((candidate) => candidate.id === threadId)));
  const globalValue = useSettingsStore((s) => s.settings.thread.completion.completeOnPrMerge);
  const setOverride = useWorkspaceStore((s) => s.setAutoCompleteOverride);
  const [failure, setFailure] = useState<{ threadId: string; message: string } | null>(null);
  if (!thread) return null;
  return {
    kind: "switch",
    label: "Close when PRs merge",
    icon: <GitMerge />,
    checked: effectiveAutoCompleteOnMerge(thread, globalValue),
    disabledReason: thread.pull_requests.length === 0 ? "No linked PRs" : null,
    description: failure?.threadId === thread.id ? failure.message : undefined,
    onCheckedChange: (next) => {
      setFailure(null);
      setOverride(thread.id, next).catch((error: unknown) => {
        setFailure({ threadId: thread.id, message: rpcFailureMessage(error) });
      });
    },
  };
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
  const autoComplete = useAutoCompleteSwitch(contextMenu?.threadId ?? null);
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
        ...(autoComplete ? [autoComplete, { label: "", onClick: () => {}, divider: true }] : []),
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
            {isDeleting && <Spinner size={16} className="text-current" />}
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
      <GitBranch size={14} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Delete worktree</div>
        <div className="text-fade text-xs text-muted">{dialog.worktreePath}</div>
      </div>
      <Switch checked={deleteWorktree} onCheckedChange={(checked) => { if (!isDeleting) onChange(checked); }} disabled={isDeleting} className="data-[checked]:not-aria-invalid:border-destructive data-[checked]:bg-destructive data-[checked]:hover:not-aria-invalid:border-button-destructive-hover data-[checked]:hover:bg-button-destructive-hover" aria-label="Delete worktree" />
    </div>
  );
}
