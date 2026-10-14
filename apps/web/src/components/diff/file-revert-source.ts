import type { ReviewTurn, TurnSnapshot } from "@mcode/contracts";
import type { FileRevertRange } from "@/features/conversation/turn-revert/revert-copy";
import { useDiffStore } from "@/stores/diffStore";
import type { DiffViewMode } from "@/stores/diffStore";

/** The turns a Review file header can revert one file across. */
export interface FileRevertSource {
  /** Server id of the last turn's assistant message. */
  readonly messageId: string;
  /** First turn of a multi-turn range. Absent for a single turn. */
  readonly fromMessageId?: string;
  readonly range: FileRevertRange;
}

function ordinalOf(messageId: string, turns: readonly ReviewTurn[]): number | null {
  return turns.find((turn) => turn.messageId === messageId)?.ordinal ?? null;
}

/** The Turn view's source: the shown turn, or null while it is unresolved. */
export function turnRevertSource(turnMessageId: string | null, turns: readonly ReviewTurn[] | undefined): FileRevertSource | null {
  if (!turnMessageId || !turns) return null;
  const ordinal = ordinalOf(turnMessageId, turns);
  return ordinal === null ? null : { messageId: turnMessageId, range: { from: ordinal, to: ordinal } };
}

function settledAttemptOfFirstTurn(rows: readonly TurnSnapshot[]): TurnSnapshot | undefined {
  const first = rows[0];
  return first ? rows[first.attempt_count - 1] : undefined;
}

/** All turns' source: from the first snapshot to the last one with both refs. */
export function allTurnsRevertSource(snapshots: readonly TurnSnapshot[], turns: readonly ReviewTurn[] | undefined): FileRevertSource | null {
  const rows = snapshots.filter((snapshot) => snapshot.ref_before && snapshot.ref_after);
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last || !turns) return null;
  const firstSettled = settledAttemptOfFirstTurn(rows);
  const from = firstSettled ? ordinalOf(firstSettled.message_id, turns) : null;
  const to = ordinalOf(last.message_id, turns);
  if (from === null || to === null) return null;
  if (from === to) return { messageId: last.message_id, range: { from, to } };
  return { messageId: last.message_id, fromMessageId: first.message_id, range: { from, to } };
}

/**
 * Where a file can be reverted from the current Review view. Only the Turn and
 * All turns views revert; git views and Since you looked have no turn range.
 */
export function useFileRevertSource(viewMode: DiffViewMode, threadId: string, turnMessageId: string | null): FileRevertSource | null {
  const turns = useDiffStore((state) => state.reviewTurnsByThread[threadId]);
  const snapshots = useDiffStore((state) => state.snapshotsByThread[threadId]);
  if (viewMode === "turn") return turnRevertSource(turnMessageId, turns);
  if (viewMode === "cumulative") return allTurnsRevertSource(snapshots ?? [], turns);
  return null;
}
