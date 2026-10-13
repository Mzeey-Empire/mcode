import { WS_METHODS, type DiffStats, type ReviewComparisonResult, type ReviewFileDiffResult, type ReviewFileChange, type WsMethodName } from "@mcode/contracts";
import type { z } from "zod";
import type { TurnSnapshotRepo } from "../../../agents/turns/persistence/turn-snapshot-repo.js";
import type { ThreadService } from "../../../thread-control/lifecycle/thread-service.js";
import type { GitWorktreeService } from "../../git/git-worktree-service.js";
import type { WorkspaceService } from "../../lifecycle/workspace-service.js";
import { assertReviewWorktree, reviewComparisonFailure, ReviewComparisonLimitError } from "../../git/review-comparison-errors.js";
import { resolveSnapshotCwd } from "../snapshots/resolve-snapshot-cwd.js";
import type { TurnRevertStore } from "../../../agents/turns/persistence/turn-revert-store.js";
import { attributedWorkspacePaths } from "../snapshots/snapshot-attribution.js";
import type { SnapshotService } from "../snapshots/snapshot-service.js";
import { snapshotRange, type TurnSnapshotRange } from "../snapshots/turn-snapshot-range-model.js";
import type { TurnSnapshotRangeReader } from "../snapshots/turn-snapshot-range.js";

type SnapshotRpcMethod = Extract<WsMethodName, `snapshot.${string}`>;
type SnapshotRpcParamsByMethod = {
  [Method in SnapshotRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};
type ReadyRange = Extract<TurnSnapshotRange, { status: "ready" }>;

/** Services required by historical and cumulative snapshot reads. */
export interface SnapshotRouterDeps {
  turnSnapshotRepo: Pick<TurnSnapshotRepo, "getById" | "deleteExpired" | "listByThread">;
  turnSnapshotRanges: Pick<TurnSnapshotRangeReader, "turnSnapshotRange" | "listTurns" | "listSnapshots">;
  snapshotService: Pick<SnapshotService, "getDiff" | "getDiffStats" | "validateRef">;
  threadService: Pick<ThreadService, "findById">;
  workspaceService: Pick<WorkspaceService, "findById">;
  gitWorktrees: Pick<GitWorktreeService, "resolveWorkingDir">;
  sweepSnapshotPins: () => Promise<void>;
  turnRevertStore?: Pick<TurnRevertStore, "revertedPathsBySnapshot">;
}

type SnapshotHandlerMap = {
  [Method in SnapshotRpcMethod]: (deps: SnapshotRouterDeps, params: SnapshotRpcParamsByMethod[Method]) => Promise<unknown> | unknown;
};

const snapshotHandlers: SnapshotHandlerMap = {
  "snapshot.getDiff": (deps, params) => readSnapshotRangeDiff(deps, rangeForSnapshot(deps, params.snapshotId), params.filePath, params.maxLines),
  "snapshot.getDiffStats": (deps, params) => readSnapshotRangeStats(deps, rangeForSnapshot(deps, params.snapshotId)),
  "snapshot.cleanup": routeSnapshotCleanup,
  "snapshot.listByThread": (deps, params) => {
    const reverted = deps.turnRevertStore?.revertedPathsBySnapshot(params.threadId);
    return deps.turnSnapshotRanges.listSnapshots(params.threadId).map((row) => {
      const attributed = new Set(attributedWorkspacePaths(row));
      return { ...row, reverted_paths: [...(reverted?.get(row.id) ?? [])].filter((path) => attributed.has(path)) };
    });
  },
  "snapshot.getCumulativeDiff": (deps, params) => {
    const range = cumulativeRange(deps, params.threadId, params.afterSequence);
    return range.status === "ready" ? readSnapshotRangeDiff(deps, range, params.filePath, params.maxLines, params.ignoreWhitespace) : "";
  },
  "snapshot.getCumulativeDiffStats": (deps, params) => readSnapshotRangeComparison(deps, cumulativeRange(deps, params.threadId, params.afterSequence), true, params.ignoreWhitespace),
};

/** Checks whether a method belongs to the snapshot RPC family. */
export function isSnapshotRpcMethod(method: WsMethodName): method is SnapshotRpcMethod {
  return Object.hasOwn(snapshotHandlers, method);
}

/** Routes validated snapshot RPC parameters to feature services. */
export async function routeSnapshotRpc<Method extends SnapshotRpcMethod>(
  method: Method, params: SnapshotRpcParamsByMethod[Method], deps: SnapshotRouterDeps,
): Promise<unknown> {
  return await snapshotHandlers[method](deps, params);
}

async function routeSnapshotCleanup(deps: SnapshotRouterDeps): Promise<{ removed: number }> {
  const removed = await deps.turnSnapshotRepo.deleteExpired(parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10));
  await deps.sweepSnapshotPins();
  return { removed };
}

function rangeForSnapshot(deps: SnapshotRouterDeps, snapshotId: string): TurnSnapshotRange {
  const snapshot = deps.turnSnapshotRepo.getById(snapshotId);
  return snapshot ? deps.turnSnapshotRanges.turnSnapshotRange(snapshot.thread_id, snapshot.message_id)
    : { status: "unavailable", reason: "snapshot-expired" };
}

function cumulativeRange(deps: SnapshotRouterDeps, threadId: string, afterSequence?: number): TurnSnapshotRange {
  return snapshotRange(deps.turnSnapshotRanges.listSnapshots(threadId, afterSequence).filter((row) => row.ref_before && row.ref_after));
}

/** Git evidence requires the original checkout and retained refs. */
export async function validateSnapshotRange(deps: SnapshotRouterDeps, range: ReadyRange): Promise<string | Exclude<ReviewComparisonResult, { status: "ready" }>> {
  if (!range.refBefore || !range.refAfter) return { status: "unavailable", reason: "snapshot-expired" };
  try {
    const cwd = resolveSnapshotCwd(deps, range.rows[0]);
    assertReviewWorktree(cwd);
    const valid = await Promise.all([deps.snapshotService.validateRef(cwd, range.refBefore), deps.snapshotService.validateRef(cwd, range.refAfter)]);
    return valid.every(Boolean) ? cwd : { status: "unavailable", reason: "snapshot-pruned" };
  } catch (error) {
    return reviewComparisonFailure(error);
  }
}

/** Read Git metadata across all joined attempts, retaining truthful failure outcomes. */
export async function readSnapshotRangeComparison(deps: SnapshotRouterDeps, range: TurnSnapshotRange, emptyIsReady = false, ignoreWhitespace = false): Promise<ReviewComparisonResult> {
  if (range.status !== "ready") return emptyIsReady ? { status: "ready", comparison: { files: [], additions: 0, deletions: 0 } } : range;
  const stats = await readSnapshotRangeStats(deps, range, ignoreWhitespace);
  if (!Array.isArray(stats)) return stats;
  return { status: "ready", comparison: {
    files: stats.map(diffStatsFile),
    additions: stats.reduce((sum, file) => sum + file.additions, 0),
    deletions: stats.reduce((sum, file) => sum + file.deletions, 0),
  } };
}

function diffStatsFile(file: DiffStats): ReviewFileChange {
  return { path: file.filePath, previousPath: null, changeType: file.changeType, binary: false,
    additions: file.additions, deletions: file.deletions, untracked: false };
}

async function readSnapshotRangeStats(deps: SnapshotRouterDeps, range: TurnSnapshotRange, ignoreWhitespace = false): Promise<DiffStats[] | Exclude<ReviewComparisonResult, { status: "ready" }>> {
  if (range.status !== "ready") return range;
  const cwd = await validateSnapshotRange(deps, range);
  if (typeof cwd !== "string") return cwd;
  try {
    const stats = await deps.snapshotService.getDiffStats(cwd, range.refBefore, range.refAfter, {
      allowedPaths: range.paths, allowedPathGroups: range.pathGroups, ignoreWhitespace,
    });
    if (stats.length > 10_000) throw new ReviewComparisonLimitError(stats.length);
    return stats;
  } catch (error) {
    return reviewComparisonFailure(error);
  }
}

/** Read a file patch from the same complete attempt range as its comparison. */
export async function readSnapshotRangeDiff(deps: SnapshotRouterDeps, range: TurnSnapshotRange, filePath?: string, maxLines?: number, ignoreWhitespace = false): Promise<ReviewFileDiffResult> {
  if (range.status !== "ready") return range;
  const cwd = await validateSnapshotRange(deps, range);
  if (typeof cwd !== "string") return cwd;
  if (filePath && !range.paths.some((path) => path.replaceAll("\\", "/") === filePath.replaceAll("\\", "/"))) return "";
  try {
    return await deps.snapshotService.getDiff(cwd, range.refBefore, range.refAfter, {
      filePath, maxLines, allowedPaths: range.paths, allowedPathGroups: range.pathGroups, ignoreWhitespace,
    });
  } catch (error) {
    return reviewComparisonFailure(error);
  }
}
