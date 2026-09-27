import type { Thread } from "@/transport";
import type { WorktreeInfo } from "@/transport/types";

const DETACHED_WORKTREE_BRANCH = "(detached)";

/**
 * Directory the thread operates in, for open-in and "Worktree path" surfaces.
 * A worktree thread whose path has not been persisted yet must not fall back
 * to the workspace checkout: the base directory is a different working tree
 * than the one the user is in.
 */
export function resolveThreadDirPath(
  thread: Pick<Thread, "mode" | "worktree_path">,
  workspacePath: string | null,
): string | null {
  return thread.worktree_path ?? (thread.mode === "worktree" ? null : workspacePath);
}

/** Normalizes a worktree path for UI-side matching. */
export function normalizeWorktreePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

/** Returns true when git reports the worktree without a named branch. */
export function isDetachedWorktree(
  worktree: Pick<WorktreeInfo, "branch"> | null | undefined,
): boolean {
  return worktree?.branch === DETACHED_WORKTREE_BRANCH;
}

/** Returns the branch-facing label for a worktree picker row. */
export function worktreeBranchLabel(
  worktree: Pick<WorktreeInfo, "branch">,
): string {
  return isDetachedWorktree(worktree) ? "HEAD" : worktree.branch;
}
