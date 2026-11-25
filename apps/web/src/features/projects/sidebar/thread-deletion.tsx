import { useCallback, useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { isNoProjectWorkspace } from "../state/project-workspaces";
import { useWorkspaceStore } from "../state/workspaceStore";

/** The thread a delete dialog asks about. */
export interface DeleteDialogState {
  threadId: string;
  threadTitle: string;
  worktreePath: string | null;
}

/** State and actions for the delete-thread dialog: open it for a thread, then confirm or close. */
export function useThreadDeletion() {
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

interface NoProjectFolder {
  path: string;
  keptForTitle: string | null;
}

/**
 * Describes the folder a No project thread's delete would take with it. Forks share their parent's
 * hidden workspace, and the server removes the folder only once no thread uses it, so the dialog
 * must say which case the user is in. Null for a project thread.
 */
function useNoProjectFolder(threadId: string | undefined): NoProjectFolder | null {
  const threads = useWorkspaceStore((s) => s.threads);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return useMemo(() => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    const workspace = workspaces.find((candidate) => candidate.id === thread?.workspace_id);
    if (!thread || !workspace || !isNoProjectWorkspace(workspace)) return null;
    const other = threads.find((candidate) => candidate.workspace_id === workspace.id && candidate.id !== thread.id);
    return { path: workspace.path, keptForTitle: other?.title ?? null };
  }, [threads, workspaces, threadId]);
}

/** Asks to confirm a thread delete, offering to delete its worktree too. */
export function ThreadDeleteDialog({
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
  const folder = useNoProjectFolder(dialog?.threadId);
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !isDeleting) onClose(); }}>
      {/* The wider No project dialog fits "Cancel" beside "Delete thread and folder" on one row. */}
      <DialogContent showCloseButton={false} className={`${folder ? "sm:max-w-lg" : "sm:max-w-md"} overflow-hidden`}>
        {/* min-w-0 lets the dialog's grid column shrink below the folder path's one-line width, so the path fades instead of widening the column past the dialog. */}
        <div className="flex min-w-0 flex-col gap-2">
          <DialogTitle>Delete thread</DialogTitle>
          {folder ? <NoProjectDeleteBody folder={folder} /> : <DialogDescription>Are you sure you want to delete &ldquo;{dialog?.threadTitle}&rdquo;? This action cannot be undone.</DialogDescription>}
        </div>
        <ThreadDeleteWorktreeOption dialog={dialog} deleteWorktree={deleteWorktree} isDeleting={isDeleting} onChange={onDeleteWorktreeChange} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" className="cursor-pointer" disabled={isDeleting} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" className="cursor-pointer" disabled={isDeleting} onClick={onConfirm}>
            {isDeleting && <Spinner size={16} className="text-current" />}
            {isDeleting ? "Deleting..." : deleteLabel(folder)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function deleteLabel(folder: NoProjectFolder | null): string {
  if (!folder) return "Delete";
  return folder.keptForTitle === null ? "Delete thread and folder" : "Delete thread";
}

function NoProjectDeleteBody({ folder }: { folder: NoProjectFolder }) {
  if (folder.keptForTitle !== null) {
    return <DialogDescription>Deletes the thread. The folder stays while &ldquo;{folder.keptForTitle}&rdquo; uses it.</DialogDescription>;
  }
  return (
    <>
      <DialogDescription>Deletes the thread, its folder, and any files the agent wrote there.</DialogDescription>
      <div className="text-fade font-mono text-xs text-muted">{folder.path}</div>
    </>
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
