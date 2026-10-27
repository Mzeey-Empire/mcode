import type { TurnSnapshot } from "@mcode/contracts/models/turn-snapshot";
import type { SnapshotRouterDeps } from "../transport/snapshot-rpc.js";
import { ReviewWorktreeMissingError } from "../../git/review-comparison-errors.js";

/** Resolve the original snapshot checkout, never falling back from a missing worktree to the main checkout. */
export function resolveSnapshotCwd(deps: Pick<SnapshotRouterDeps, "threadService" | "workspaceService" | "gitWorktrees">, first: Pick<TurnSnapshot, "thread_id" | "worktree_path">): string {
  const thread = deps.threadService.findById(first.thread_id);
  if (!thread) throw new Error(`Thread not found for snapshot: ${first.thread_id}`);
  const workspace = deps.workspaceService.findById(thread.workspace_id);
  if (!workspace) throw new Error(`Workspace not found: ${thread.workspace_id}`);
  if (!first.worktree_path && thread.mode === "worktree" && !thread.worktree_path) throw new ReviewWorktreeMissingError("Thread worktree path is missing");
  return first.worktree_path ?? deps.gitWorktrees.resolveWorkingDir(workspace.path, thread.mode, thread.worktree_path);
}
