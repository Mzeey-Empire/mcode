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

function turnGroups(snapshots: readonly TurnSnapshot[]): TurnSnapshot[][] {
  const groups: TurnSnapshot[][] = [];
  for (let index = 0; index < snapshots.length; ) {
    const size = Math.max(1, snapshots[index]?.attempt_count ?? 1);
    groups.push(snapshots.slice(index, index + size));
    index += size;
  }
  return groups;
}

/** A turn's boundary attempt row, and the settled attempt whose message id the turn list carries. */
interface TurnEnd {
  readonly row: TurnSnapshot;
  readonly settledMessageId: string;
}

function turnEnds(
  snapshots: readonly TurnSnapshot[],
  turns: readonly ReviewTurn[],
  pick: (rows: TurnSnapshot[]) => TurnSnapshot | undefined,
): TurnEnd[] {
  return turnGroups(snapshots).flatMap((group) => {
    const row = pick(group);
    const settled = group.at(-1);
    // A turn retrying live has no settled row yet, so its group is not in the turn list.
    return row && settled && ordinalOf(settled.message_id, turns) !== null ? [{ row, settledMessageId: settled.message_id }] : [];
  });
}

/**
 * All turns' source. The server reverts whole turns, from the first attempt's ref_before to the settled
 * attempt's ref_after, so the range runs from the first turn that has the former to the last that has the latter.
 */
export function allTurnsRevertSource(snapshots: readonly TurnSnapshot[], turns: readonly ReviewTurn[] | undefined): FileRevertSource | null {
  if (!turns) return null;
  const first = turnEnds(snapshots, turns, (rows) => (rows[0]?.ref_before ? rows[0] : undefined))[0];
  const last = turnEnds(snapshots, turns, (rows) => (rows.at(-1)?.ref_after ? rows.at(-1) : undefined)).at(-1);
  if (!first || !last) return null;
  const from = ordinalOf(first.settledMessageId, turns);
  const to = ordinalOf(last.settledMessageId, turns);
  if (from === null || to === null) return null;
  const range = { from, to };
  return from === to
    ? { messageId: last.row.message_id, range }
    : { messageId: last.row.message_id, fromMessageId: first.row.message_id, range };
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
