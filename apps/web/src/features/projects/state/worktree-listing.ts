import type { Thread, WorktreeInfo } from "@/transport";
import { normalizeWorktreePath } from "@/lib/worktree";

const FIRST_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * What the client knows about the active project's git worktrees.
 *
 * A path missing from `worktrees` does not by itself mean the directory is gone: a
 * delegated task, a thread launch, or a fork can add a worktree thread after the
 * listing loaded. Read presence through {@link worktreePresence}, never by searching
 * `worktrees` directly.
 */
export interface WorktreeListing {
  /** Project this listing describes; null when no project is active. */
  readonly workspaceId: string | null;
  /** Worktrees from the latest successful listing. */
  readonly worktrees: readonly WorktreeInfo[];
  /** Normalized paths of `worktrees`. */
  readonly listedPaths: ReadonlySet<string>;
  /** Normalized worktree thread paths the client knew when the latest successful listing started. */
  readonly checkedPaths: ReadonlySet<string>;
  /** Normalized worktree thread paths the client knew when the latest request started, whatever its outcome. */
  readonly requestedPaths: ReadonlySet<string>;
  /** Id of the latest request or project switch; an answer carrying an older id is discarded. */
  readonly requestId: number;
  /** Listings that failed in a row since the last success; sets the wait before the next retry. */
  readonly failedAttempts: number;
}

/**
 * Whether a worktree thread's directory exists, as far as the client can tell.
 * `unchecked` means no successful listing has answered for the path yet. A failed
 * listing keeps what the last successful one established.
 */
export type WorktreePresence = "present" | "missing" | "unchecked";

type WorktreeThread = Pick<Thread, "workspace_id" | "mode" | "worktree_path">;

/** An empty listing for `workspaceId` with the given request id. Callers pass a higher id to discard answers still in flight. */
export function emptyWorktreeListing(workspaceId: string | null, requestId = 0): WorktreeListing {
  return {
    workspaceId, worktrees: [], listedPaths: new Set(), checkedPaths: new Set(), requestedPaths: new Set(), requestId, failedAttempts: 0,
  };
}

/** Records a successful answer to a request that started when the client knew `checkedPaths`. */
export function withListedWorktrees(
  listing: WorktreeListing,
  worktrees: readonly WorktreeInfo[],
  checkedPaths: ReadonlySet<string>,
): WorktreeListing {
  const listedPaths = new Set(worktrees.map((worktree) => normalizeWorktreePath(worktree.path)));
  return { ...listing, worktrees, listedPaths, checkedPaths, failedAttempts: 0 };
}

/** Records a failed listing; the listed worktrees and checked paths stay as the last success left them. */
export function withFailedListing(listing: WorktreeListing): WorktreeListing {
  return { ...listing, failedAttempts: listing.failedAttempts + 1 };
}

/**
 * Forgets a `missing` answer for a path the server just assigned, which can reuse a path an
 * earlier listing found missing. The caller then starts a fresh listing to answer for it.
 */
export function withReassignedPath(listing: WorktreeListing, worktreePath: string): WorktreeListing {
  const path = normalizeWorktreePath(worktreePath);
  return { ...listing, checkedPaths: new Set([...listing.checkedPaths].filter((checked) => checked !== path)) };
}

/** Wait before retrying a failed listing: doubles from 2 seconds per failure in a row, up to 1 minute. */
export function worktreeRetryDelayMs(failedAttempts: number): number {
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** Math.max(failedAttempts - 1, 0), MAX_RETRY_DELAY_MS);
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

/**
 * True when the thread's presence is unchecked and its path was not in the latest request.
 * One listing answers for every path known when it starts.
 */
export function needsWorktreeCheck(listing: WorktreeListing, thread: WorktreeThread): boolean {
  if (!thread.worktree_path || worktreePresence(listing, thread) !== "unchecked") return false;
  return !listing.requestedPaths.has(normalizeWorktreePath(thread.worktree_path));
}
