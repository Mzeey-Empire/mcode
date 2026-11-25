import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useUiStore } from "@/stores/uiStore";
import type { Thread, Workspace } from "@/transport/types";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useWorkspaceStore } from "./state/workspaceStore";
import { needsWorktreeCheck } from "./state/worktree-listing";
import { useSidebarUiStore } from "./sidebar/sidebar-ui-store";
import type { InlineEditState, SidebarRowContext } from "./sidebar/sidebar-row-context";
import { ThreadDeleteDialog, useThreadDeletion } from "./sidebar/thread-deletion";
import { ThreadContextMenu, type ThreadMenuActions, type ThreadMenuTarget } from "./sidebar/thread-menu";
import { openRightPanelTab } from "@/lib/right-panel-layout";

/** Time window in ms during which a second click on the same thread row is treated as a double-click. */
const DOUBLE_CLICK_THRESHOLD_MS = 250;

interface ContextMenuState extends ThreadMenuTarget {
  x: number;
  y: number;
  anchor: Element;
}

interface DraftContextMenuState {
  x: number;
  y: number;
  draftId: string;
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

function useRefreshWorktreesForNewPaths(): void {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadWorktrees = useWorkspaceStore((s) => s.loadWorktrees);
  const needsCheck = useWorkspaceStore((s) => activeWorkspaceId !== null && s.threads.some(
    (thread) => thread.workspace_id === activeWorkspaceId && needsWorktreeCheck(s.worktreeListing, thread),
  ));
  useEffect(() => {
    if (activeWorkspaceId && needsCheck) void loadWorktrees(activeWorkspaceId);
  }, [activeWorkspaceId, needsCheck, loadWorktrees]);
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
    setThreadMenu({ x: event.clientX, y: event.clientY, anchor: event.currentTarget, threadId: thread.id, threadTitle: thread.title, workspacePath, worktreePath: thread.worktree_path });
  }, []);
  const openDraftMenu = useCallback((event: React.MouseEvent, draftId: string) => {
    event.preventDefault();
    setDraftMenu({ x: event.clientX, y: event.clientY, draftId });
  }, []);
  return { threadMenu, setThreadMenu, draftMenu, setDraftMenu, openThreadMenu, openDraftMenu };
}

function useRowFacts() {
  const worktreeListing = useWorkspaceStore((s) => s.worktreeListing);
  const availableProviders = useProviderAvailabilityStore((s) => s.providers);
  return { worktreeListing, availableProviders };
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
  useRefreshWorktreesForNewPaths();

  const { worktreeListing, availableProviders } = facts;
  const { setInlineEdit } = rename;
  const openDeletion = deletion.open;
  const selectThread = clicks.select;
  const threadMenuActions = useMemo<ThreadMenuActions>(() => ({
    onRename: (target) => setInlineEdit({ threadId: target.threadId, title: target.threadTitle, originalTitle: target.threadTitle }),
    onDelete: (target) => openDeletion({ threadId: target.threadId, threadTitle: target.threadTitle, worktreePath: target.worktreePath }),
    onOpenProjectSettings: (target, workspaceId) => {
      selectThread(workspaceId, target.threadId);
      openRightPanelTab(workspaceId, target.threadId, "environment");
    },
    renamingThreadId: rename.inlineEdit?.threadId ?? null,
  }), [setInlineEdit, openDeletion, selectThread, rename.inlineEdit]);
  const ctx = useMemo<SidebarRowContext>(() => ({
    worktreeListing,
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
    threadMenuActions,
    onReopenThread: reopenThread,
    onRetryThreadCleanup: retryThreadCleanup,
    onOpenDraft: actions.openDraft,
    onDiscardDraft: actions.discardDraft,
    onDraftContextMenu: menus.openDraftMenu,
  }), [
    worktreeListing, availableProviders,
    rename.inlineEdit, rename.change, rename.commit, rename.cancel,
    toggleProject, toggleShowMore, actions.createThread, actions.openDraft, actions.discardDraft,
    projects.openDelete, projects.openRename, clicks.click, clicks.doubleClick, clicks.select,
    menus.openThreadMenu, menus.openDraftMenu, reopenThread, retryThreadCleanup, threadMenuActions,
  ]);

  const overlays = (
    <>
      <ThreadContextMenuOverlay
        contextMenu={menus.threadMenu}
        onClose={() => menus.setThreadMenu(null)}
        actions={threadMenuActions}
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

function ThreadContextMenuOverlay({
  contextMenu,
  onClose,
  actions,
}: {
  contextMenu: ContextMenuState | null;
  onClose: () => void;
  actions: ThreadMenuActions;
}) {
  if (!contextMenu) return null;
  return <ThreadContextMenu key={`${contextMenu.threadId}:${contextMenu.x}:${contextMenu.y}`} target={contextMenu} point={contextMenu} actions={actions} onClose={onClose} />;
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
