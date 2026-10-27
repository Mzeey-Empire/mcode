import { useEffect, useMemo, useState } from "react";
import type { DiffStats } from "@mcode/contracts/models/diff-stats";
import type { TurnSnapshot } from "@mcode/contracts/models/turn-snapshot";
import { useDiffStore } from "@/stores/diffStore";
import { readThreadRecord } from "@/stores/thread-selectors";
import { getTransport } from "@/transport";
import {
  filesFromEffects,
  filesFromStats,
  pathsEditedLater,
  recordedEffects,
  revertedPaths,
  toForwardSlashes,
  type TurnChanges,
} from "./changes-tree";

/** Stats for one snapshot, or `failed` when the range could not be counted. */
interface StatsResult {
  readonly snapshotId: string;
  readonly stats: readonly DiffStats[] | "failed";
}

/**
 * Recorded effects describe one attempt's net change. A retried turn's
 * snapshot spans every attempt, so only git stats over the range are true.
 */
function needsRangeStats(snapshot: TurnSnapshot): boolean {
  return !recordedEffects(snapshot) || snapshot.attempt_count > 1;
}

interface SnapshotListFetch {
  readonly threadId: string;
  readonly ok: boolean;
}

/**
 * Fetches the thread's snapshot list when the store lacks it, or when the
 * cached list predates this turn. Returns the thread's settled fetch, if any.
 */
function useSnapshotList(
  threadId: string | null | undefined,
  hasSnapshot: boolean,
): SnapshotListFetch | null {
  const [settled, setSettled] = useState<SnapshotListFetch | null>(null);
  const settledFor = settled?.threadId ?? null;

  useEffect(() => {
    if (!threadId || hasSnapshot || settledFor === threadId) return;
    let cancelled = false;
    getTransport()
      .listSnapshots(threadId)
      .then((snapshots) => {
        useDiffStore.getState().setSnapshots(threadId, snapshots);
        if (!cancelled) setSettled({ threadId, ok: true });
      })
      .catch(() => {
        if (!cancelled) setSettled({ threadId, ok: false });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, hasSnapshot, settledFor]);

  return settled;
}

function snapshotListState(threadId: string | null | undefined, settled: SnapshotListFetch | null) {
  const own = !threadId || settled?.threadId === threadId;
  return { listSettled: own, listLoaded: own && (!threadId || settled?.ok === true) };
}

function useRangeStats(snapshotId: string | null): StatsResult | null {
  const [result, setResult] = useState<StatsResult | null>(null);

  useEffect(() => {
    if (!snapshotId || result?.snapshotId === snapshotId) return;
    let cancelled = false;
    const settle = (stats: StatsResult["stats"]) => {
      if (!cancelled) setResult({ snapshotId, stats });
    };
    getTransport()
      .getSnapshotDiffStats(snapshotId)
      .then((stats) => settle(Array.isArray(stats) ? stats : "failed"))
      .catch(() => settle("failed"));
    return () => {
      cancelled = true;
    };
  }, [snapshotId, result]);

  return result?.snapshotId === snapshotId ? result : null;
}

interface ResolveInput {
  readonly snapshot: TurnSnapshot | undefined;
  readonly snapshots: readonly TurnSnapshot[];
  readonly listSettled: boolean;
  readonly stats: StatsResult | null;
  readonly filesChanged: readonly string[];
}

function resolveTurnChanges({ snapshot, snapshots, listSettled, stats, filesChanged }: ResolveInput): TurnChanges {
  if (!snapshot) {
    const paths = filesChanged.map(toForwardSlashes);
    return listSettled ? { status: "unavailable", paths } : { status: "loading", paths };
  }
  const marks = { editedLater: pathsEditedLater(snapshot, snapshots), reverted: revertedPaths(snapshot) };
  const effects = recordedEffects(snapshot);
  if (effects && !needsRangeStats(snapshot)) {
    return { status: "ready", files: filesFromEffects(effects, marks) };
  }
  const paths = snapshot.files_changed.map(toForwardSlashes);
  if (!stats) return { status: "loading", paths };
  if (stats.stats === "failed") return { status: "unavailable", paths };
  return { status: "ready", files: filesFromStats(stats.stats, marks) };
}

/** One turn's changes plus the snapshot facts the turn menu needs. */
export interface TurnChangesResult {
  readonly changes: TurnChanges;
  /** The turn's snapshot, or undefined while loading or once it is gone. */
  readonly snapshot: TurnSnapshot | undefined;
  /** Server id of the turn's assistant message. */
  readonly serverMessageId: string;
  /** The thread's snapshot list loaded, so a missing snapshot is really gone; a failed fetch proves nothing. */
  readonly listLoaded: boolean;
}

/**
 * Loads what one turn changed for the end-of-turn changes bar. Recorded file
 * effects answer without a request; legacy and retried turns count lines
 * over the snapshot's git range. Always reads `threadId`'s snapshots, never
 * the active thread's, so a bar stays correct while another thread is open.
 */
export function useTurnChanges(
  threadId: string | null | undefined,
  messageId: string,
  filesChanged: readonly string[],
): TurnChangesResult {
  const snapshots = useDiffStore((s) => (threadId ? s.snapshotsByThread[threadId] : undefined));
  const serverMessageId = threadId
    ? (readThreadRecord(threadId).serverMessageIds[messageId] ?? messageId)
    : messageId;
  const snapshot = snapshots?.find((s) => s.message_id === serverMessageId);
  const settled = useSnapshotList(threadId, snapshot !== undefined);
  const stats = useRangeStats(snapshot && needsRangeStats(snapshot) ? snapshot.id : null);
  const { listSettled, listLoaded } = snapshotListState(threadId, settled);

  const changes = useMemo(
    () => resolveTurnChanges({ snapshot, snapshots: snapshots ?? [], listSettled, stats, filesChanged }),
    [snapshot, snapshots, listSettled, stats, filesChanged],
  );
  return { changes, snapshot, serverMessageId, listLoaded };
}
