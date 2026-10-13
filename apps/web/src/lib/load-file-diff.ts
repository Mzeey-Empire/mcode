import type { ReviewFileDiffResult } from "@mcode/contracts";
import type { DiffReadOptions, McodeTransport } from "@/transport/types";
import type { DiffSource } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

async function loadBranchFileDiff(
  transport: McodeTransport,
  id: string,
  filePath: string,
  threadId: string | undefined,
  options: DiffReadOptions | undefined,
): Promise<string> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!workspaceId) return "";
  const separator = id.indexOf("...");
  const base = separator >= 0 ? id.slice(0, separator) : undefined;
  const target = separator >= 0 ? id.slice(separator + 3) : undefined;
  return transport.getBranchDiff(workspaceId, base, target, filePath, undefined, threadId, options);
}

async function loadCommitFileDiff(
  transport: McodeTransport,
  id: string,
  filePath: string,
  options: DiffReadOptions | undefined,
): Promise<string> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  return workspaceId ? transport.getCommitDiff(workspaceId, id, filePath, undefined, options) : "";
}

/** A file patch the server reported as unavailable, kept distinct from an empty patch. */
export class ReviewFileDiffUnavailableError extends Error {
  readonly result: Exclude<ReviewFileDiffResult, string>;

  constructor(result: Exclude<ReviewFileDiffResult, string>) {
    super(`File diff unavailable: ${result.status}`);
    this.name = "ReviewFileDiffUnavailableError";
    this.result = result;
  }
}

/**
 * The sources that need a thread, read as empty without one: `id` is the
 * turn-diff id, or the seen baseline for Since you looked.
 */
async function loadThreadFileDiff(
  transport: McodeTransport,
  source: "turn-diff" | "since-looked",
  id: string,
  filePath: string,
  threadId: string | undefined,
  options: DiffReadOptions | undefined,
): Promise<string> {
  if (!threadId) return "";
  return patchOrThrow(source === "turn-diff"
    ? await transport.getTurnDiffFile(threadId, id, filePath, options)
    : await transport.getCumulativeDiff(threadId, filePath, undefined, Number(id), options));
}

function patchOrThrow(result: ReviewFileDiffResult): string {
  if (typeof result === "string") return result;
  throw new ReviewFileDiffUnavailableError(result);
}

/**
 * Fetch the unified diff for a single file in a Review view. Centralizes the
 * per-source routing for Review file content. The `id` resolves the diff
 * for each {@link DiffSource}: snapshot or turn-diff ID, thread ID, the seen baseline
 * sequence for `"since-looked"`, commit SHA, the
 * `base...target` comparison range for `"branch"`, or the workspace ID for the
 * working-tree views. For the git views `threadId` (when a real thread) makes
 * the diff read the thread's worktree rather than the workspace root; the server
 * treats a non-thread id as the workspace root. `options.ignoreWhitespace` hides
 * whitespace changes in Git patches; the snapshot source ignores it. Throws
 * {@link ReviewFileDiffUnavailableError} when the server cannot produce the patch.
 */
export async function loadFileDiff(
  transport: McodeTransport,
  source: DiffSource,
  id: string,
  filePath: string,
  threadId?: string,
  untracked = false,
  previousPath?: string,
  options?: DiffReadOptions,
): Promise<string> {
  switch (source) {
    case "turn-diff":
    case "since-looked":
      return loadThreadFileDiff(transport, source, id, filePath, threadId, options);
    case "snapshot":
      return patchOrThrow(await transport.getSnapshotDiff(id, filePath));
    case "cumulative":
      return patchOrThrow(await transport.getCumulativeDiff(id, filePath, undefined, undefined, options));
    case "unstaged":
      return transport.getWorkingTreeDiff(id, false, filePath, undefined, threadId, untracked, previousPath, options);
    case "staged":
      return transport.getWorkingTreeDiff(id, true, filePath, undefined, threadId, false, previousPath, options);
    case "branch":
      // For branch, `id` is the comparison range `base...target` (git refnames
      // can't contain ".."), so the cache key and per-file fetch vary by pair.
      return loadBranchFileDiff(transport, id, filePath, threadId, options);
    case "commit":
      return loadCommitFileDiff(transport, id, filePath, options);
  }
}
