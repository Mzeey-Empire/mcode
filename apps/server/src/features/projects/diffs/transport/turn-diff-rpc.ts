import type { ReviewComparison, ReviewComparisonResult, ReviewFileDiffResult, ReviewFileChange, ReviewTurn, TurnSnapshot, WsMethodName, WS_METHODS } from "@mcode/contracts";
import type { z } from "zod";
import type { TurnDiffService } from "../../../agents/turns/turn-diff-service.js";
import { parseTurnDiff } from "../../../agents/turns/turn-diff-patch.js";
import type { StoredTurnDiff } from "../../../agents/turns/persistence/turn-diff-repo.js";
import { readSnapshotRangeComparison, readSnapshotRangeDiff, type SnapshotRouterDeps } from "./snapshot-rpc.js";
import { reviewComparisonFailure } from "../../git/review-comparison-errors.js";
import { snapshotRange, type SnapshotTurn, type TurnSnapshotRange } from "../snapshots/turn-snapshot-range.js";

type TurnDiffMethod = Extract<WsMethodName, `turnDiff.${string}`>;
type TurnDiffParams = { [M in TurnDiffMethod]: z.input<ReturnType<typeof WS_METHODS>[M]["params"]> };

/** Services used by the provider-neutral turn comparison endpoints. */
export interface TurnDiffRouterDeps extends SnapshotRouterDeps {
  turnDiffs: TurnDiffService;
}

/** Recognize the turn comparison RPC family. */
export function isTurnDiffRpcMethod(method: WsMethodName): method is TurnDiffMethod {
  return method === "turnDiff.getComparison" || method === "turnDiff.getFileDiff" || method === "turnDiff.listTurns";
}

/** Read whole-turn evidence independently of provider identity. */
export async function routeTurnDiffRpc<M extends TurnDiffMethod>(method: M, params: TurnDiffParams[M], deps: TurnDiffRouterDeps): Promise<unknown> {
  if (!deps.threadService.findById(params.threadId)) throw new Error("Thread not found");
  if (method === "turnDiff.listTurns") return deps.turnSnapshotRanges.listTurns(params.threadId).map((turn) => listEntry(deps, params.threadId, turn));
  if (method === "turnDiff.getComparison") return comparison(deps, params.threadId, "includeLive" in params ? params.includeLive : undefined, "messageId" in params ? params.messageId : undefined);
  if ("comparisonId" in params) return fileDiff(deps, params);
  throw new Error("Invalid turn diff request");
}

async function comparison(deps: TurnDiffRouterDeps, threadId: string, includeLive = true, messageId?: string): Promise<ReviewComparisonResult> {
  if (!messageId && includeLive) {
    const live = deps.turnDiffs.liveComparison(threadId);
    if (live) return { status: "ready", comparison: live };
  }
  const selected = messageId ?? latestSettledMessage(deps, threadId);
  if (!selected) return deps.turnSnapshotRanges.listTurns(threadId).length === 0
    ? { status: "ready", comparison: { files: [], additions: 0, deletions: 0 } }
    : { status: "unavailable", reason: "snapshot-expired" };
  const range = deps.turnSnapshotRanges.turnSnapshotRange(threadId, selected);
  if (range.status !== "ready") return range;
  return settledComparison(deps, threadId, range);
}

function latestSettledMessage(deps: TurnDiffRouterDeps, threadId: string): string | undefined {
  const record = deps.turnDiffs.latest(threadId);
  if (record) return record.message_id;
  const legacyId = deps.turnDiffs.latestLegacySnapshotId(threadId);
  return deps.turnSnapshotRepo.listByThread(threadId).find((row) => row.id === legacyId)?.message_id;
}

async function settledComparison(deps: TurnDiffRouterDeps, threadId: string, range: Extract<TurnSnapshotRange, { status: "ready" }>): Promise<ReviewComparisonResult> {
  const last = range.rows.at(-1)!;
  const record = deps.turnDiffs.forMessage(threadId, last.message_id);
  if (range.rows.length === 1 && record && record.source !== "git") {
    try {
      return { status: "ready", comparison: nativeComparison(record) };
    } catch (error) {
      return reviewComparisonFailure(error);
    }
  }
  const result = await readSnapshotRangeComparison(deps, range);
  if (result.status !== "ready") return result;
  const metadata = { id: range.rows.length === 1 && record ? record.id : `git:${last.id}`,
    phase: "settled" as const, source: "git" as const, fidelity: "same-file-changes-possible" as const, revision: 0 };
  if (range.rows.length === 1) {
    result.comparison.files = singleSnapshotFiles(last, result.comparison.files);
  }
  return { status: "ready", comparison: { ...result.comparison, turnDiff: metadata } };
}

function singleSnapshotFiles(snapshot: TurnSnapshot, files: ReviewFileChange[]): ReviewFileChange[] {
  const stats = new Map(files.map((file) => [file.path, file]));
  return fallbackFiles(snapshot).map((file) => ({ ...file,
    additions: file.binary ? null : stats.get(file.path)?.additions ?? null,
    deletions: file.binary ? null : stats.get(file.path)?.deletions ?? null,
  }));
}

function nativeComparison(record: StoredTurnDiff): ReviewComparison {
  const parsed = record.patch ? parseTurnDiff(record.patch) : { files: [], additions: 0, deletions: 0 };
  if (!parsed) throw new Error("Invalid stored turn diff");
  return { files: parsed.files, additions: parsed.additions, deletions: parsed.deletions,
    turnDiff: { id: record.id, phase: "settled", source: record.source, fidelity: "agent", revision: record.revision } };
}

function fallbackFiles(snapshot: TurnSnapshot): ReviewFileChange[] {
  const effects = snapshot.file_effects?.effects.filter((effect) => effect.scope === "workspace") ?? [];
  if (effects.length === 0) return snapshot.files_changed.map((path) => ({ path, previousPath: null, changeType: "modified", binary: false, additions: null, deletions: null, untracked: false }));
  return effects.map((effect) => ({ path: effect.path, previousPath: effect.oldPath ?? null, binary: effect.binary,
    additions: null, deletions: null, untracked: false,
    changeType: effect.kind === "removed" ? "deleted" : effect.kind === "edited" ? "modified" : effect.kind }));
}

async function fileDiff(deps: TurnDiffRouterDeps, params: TurnDiffParams["turnDiff.getFileDiff"]): Promise<ReviewFileDiffResult> {
  const live = deps.turnDiffs.liveFileDiff(params.threadId, params.comparisonId, params.filePath);
  if (live !== undefined) return live;
  const record = deps.turnDiffs.find(params.threadId, params.comparisonId);
  const snapshot = deps.turnSnapshotRepo.listByThread(params.threadId).find((entry) => `git:${entry.id}` === params.comparisonId);
  const messageId = record?.message_id ?? snapshot?.message_id;
  if (!messageId) return { status: "unavailable", reason: "snapshot-expired" };
  const range = deps.turnSnapshotRanges.turnSnapshotRange(params.threadId, messageId);
  if (range.status !== "ready") return range;
  return settledFileDiff(deps, params, range);
}

async function settledFileDiff(deps: TurnDiffRouterDeps, params: TurnDiffParams["turnDiff.getFileDiff"], range: Extract<TurnSnapshotRange, { status: "ready" }>): Promise<ReviewFileDiffResult> {
  const latest = deps.turnDiffs.forMessage(params.threadId, range.rows.at(-1)!.message_id);
  if (range.rows.length !== 1 || !latest || latest.source === "git") return readSnapshotRangeDiff(deps, range, params.filePath);
  if (!latest.patch) return "";
  const parsed = parseTurnDiff(latest.patch);
  return parsed ? parsed.filePatches.get(params.filePath) ?? "" : reviewComparisonFailure(new Error("Invalid stored turn diff"));
}

function listEntry(deps: TurnDiffRouterDeps, threadId: string, turn: SnapshotTurn): ReviewTurn {
  const base = { messageId: turn.messageId, ordinal: turn.ordinal, createdAt: turn.createdAt, phase: turn.phase };
  const live = turn.phase === "live" ? deps.turnDiffs.liveComparison(threadId) : null;
  if (live) return { ...base, fileCount: live.files.length, additions: live.additions, deletions: live.deletions,
    evidence: "native", availability: "available" };
  if (!turn.complete || turn.rows.length === 0) return { ...base, fileCount: 0, additions: null, deletions: null, evidence: null, availability: "snapshot-expired" };
  const range = snapshotRange(turn.rows);
  if (range.status !== "ready") return { ...base, fileCount: 0, additions: null, deletions: null, evidence: null, availability: "snapshot-expired" };
  if (range.rows.length > 1) return { ...base, fileCount: range.paths.length, additions: null, deletions: null, evidence: "git", availability: "available" };
  return { ...base, ...singleSnapshotEntry(deps, threadId, range.rows[0]) };
}

function singleSnapshotEntry(deps: TurnDiffRouterDeps, threadId: string, snapshot: TurnSnapshot): Pick<ReviewTurn, "fileCount" | "additions" | "deletions" | "evidence" | "availability"> {
  const record = deps.turnDiffs.forMessage(threadId, snapshot.message_id);
  return { fileCount: fallbackFiles(snapshot).length,
    additions: snapshot.file_effects?.additions ?? null, deletions: snapshot.file_effects?.deletions ?? null,
    evidence: record?.source ?? "git", availability: "available" };
}
