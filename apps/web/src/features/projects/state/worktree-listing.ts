import type { Thread, WorktreeInfo } from "@/transport";
import { normalizeWorktreePath } from "@/lib/worktree";

/**
 * What the client knows about the active project's git worktrees.
 *
 * A path missing from `worktrees` does not by itself mean the directory is gone: a
 * delegated task, a thread launch, or a fork can add a worktree thread after the
 * listing loaded. Read presence through {@link worktreePresence}, never by searching
 * `worktrees` directly.
 */
export interface WorktreeListing {
  /** Project this listing describes; null before the first request. */
  readonly workspaceId: string | null;
  /** Worktrees from the latest successful listing. */
  readonly worktrees: readonly WorktreeInfo[];
  /** Normalized paths of `worktrees`. */
  readonly listedPaths: ReadonlySet<string>;
  /** Normalized worktree thread paths the client knew when the latest successful listing started. */
  readonly checkedPaths: ReadonlySet<string>;
  /** Normalized worktree thread paths the client knew when the latest request started, whatever its outcome. */
  readonly requestedPaths: ReadonlySet<string>;
  /** Id of the latest request, so an answer that arrives after a newer request is dropped. */
  readonly requestId: number;
}

/**
 * Whether a worktree thread's directory exists, as far as the client can tell.
 * `unchecked` covers a path git has not been asked about yet and a listing that failed.
 */
export type WorktreePresence = "present" | "missing" | "unchecked";

type WorktreeThread = Pick<Thread, "workspace_id" | "mode" | "worktree_path">;

/** Listing for `workspaceId` before any request; keeps `requestId` rising so late answers stay dropped. */
export function emptyWorktreeListing(workspaceId: string | null, requestId = 0): WorktreeListing {
  return { workspaceId, worktrees: [], listedPaths: new Set(), checkedPaths: new Set(), requestedPaths: new Set(), requestId };
}

/** Records a successful answer to a request that started when the client knew `checkedPaths`. */
export function withListedWorktrees(
  listing: WorktreeListing,
  worktrees: readonly WorktreeInfo[],
  checkedPaths: ReadonlySet<string>,
): WorktreeListing {
  const listedPaths = new Set(worktrees.map((worktree) => normalizeWorktreePath(worktree.path)));
  return { ...listing, worktrees, listedPaths, checkedPaths };
}

/** Normalized worktree paths of the project's worktree threads. */
export function knownWorktreePaths(threads: readonly WorktreeThread[], workspaceId: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const thread of threads) {
    if (thread.workspace_id === workspaceId && thread.mode === "worktree" && thread.worktree_path) {
      paths.add(normalizeWorktreePath(thread.worktree_path));
    }
  }
  return paths;
}

/**
 * Says `missing` only when git listed the project's worktrees after the client knew this
 * thread's path, and that listing left the path out.
 */
export function worktreePresence(listing: WorktreeListing, thread: WorktreeThread): WorktreePresence {
  if (thread.mode !== "worktree" || !thread.worktree_path) return "present";
  if (listing.workspaceId !== thread.workspace_id) return "unchecked";
  const path = normalizeWorktreePath(thread.worktree_path);
  if (listing.listedPaths.has(path)) return "present";
  return listing.checkedPaths.has(path) ? "missing" : "unchecked";
}

/** True when the thread's path is unchecked and no request has asked about it yet, so each new path costs one listing. */
export function needsWorktreeCheck(listing: WorktreeListing, thread: WorktreeThread): boolean {
  if (!thread.worktree_path || worktreePresence(listing, thread) !== "unchecked") return false;
  return !listing.requestedPaths.has(normalizeWorktreePath(thread.worktree_path));
}
