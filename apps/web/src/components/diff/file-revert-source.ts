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

/** All turns' source: from the first turn to the last one whose settled attempt has both refs. */
export function allTurnsRevertSource(snapshots: readonly TurnSnapshot[], turns: readonly ReviewTurn[] | undefined): FileRevertSource | null {
  const settledGroups = turnGroups(snapshots).filter((group) => group.at(-1)?.ref_before && group.at(-1)?.ref_after);
  const first = settledGroups[0];
  const last = settledGroups.at(-1)?.at(-1);
  const firstSettled = first?.at(-1);
  if (!first || !last || !firstSettled || !turns) return null;
  const from = ordinalOf(firstSettled.message_id, turns);
  const to = ordinalOf(last.message_id, turns);
  if (from === null || to === null) return null;
  if (from === to) return { messageId: last.message_id, range: { from, to } };
  return { messageId: last.message_id, fromMessageId: first[0]?.message_id, range: { from, to } };
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
