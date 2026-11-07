import type { Thread } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resolveScopeBasePath } from "@/lib/resolve-scope-path";
import { normalizeWorktreePath } from "@/lib/worktree";
import { useDiffStore } from "@/stores/diffStore";

/**
 * Bump the diff revision of every scope that reads the checkout `changedScopeId`
 * works in: the workspace view and each thread of the workspace that resolves
 * to the same directory. Git readers key their requests by this revision, so
 * after a branch switch or HEAD move no reader, mounted or not, can reuse a
 * read that started before the change. Threads in other worktrees keep their
 * revision because their checkout did not move.
 */
export function bumpCheckoutRevisions(workspaceId: string, changedScopeId: string = workspaceId): void {
  const scopes = new Set([changedScopeId, ...scopesSharingCheckout(workspaceId, changedScopeId)]);
  useDiffStore.getState().bumpDiffRevisions([...scopes]);
}

function scopesSharingCheckout(workspaceId: string, changedScopeId: string): string[] {
  const { threads, workspaces } = useWorkspaceStore.getState();
  const changed = checkoutKey(resolveScopeBasePath(changedScopeId, workspaceId, threads, workspaces));
  if (changed === null) return [];
  const workspacePath = workspaces.find((workspace) => workspace.id === workspaceId)?.path ?? null;
  const threadIds = threads
    .filter((thread) => thread.workspace_id === workspaceId && checkoutKey(threadCheckoutPath(thread, workspacePath)) === changed)
    .map((thread) => thread.id);
  return checkoutKey(workspacePath) === changed ? [workspaceId, ...threadIds] : threadIds;
}

/** Mirrors resolveScopeBasePath: only a worktree thread with a path leaves the workspace root. */
function threadCheckoutPath(thread: Pick<Thread, "mode" | "worktree_path">, workspacePath: string | null): string | null {
  return thread.mode === "worktree" && thread.worktree_path ? thread.worktree_path : workspacePath;
}

function checkoutKey(path: string | null): string | null {
  return path === null ? null : normalizeWorktreePath(path);
}
