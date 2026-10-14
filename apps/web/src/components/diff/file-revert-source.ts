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

function hasBothRefs(snapshot: TurnSnapshot): boolean {
  return Boolean(snapshot.ref_before && snapshot.ref_after);
}

/** A turn's first attempt row that has both refs, and the settled attempt whose message id the turn list carries. */
interface TurnEnd {
  readonly row: TurnSnapshot;
  readonly settledMessageId: string;
}

function turnEnds(snapshots: readonly TurnSnapshot[], pick: (rows: TurnSnapshot[]) => TurnSnapshot | undefined): TurnEnd[] {
  return turnGroups(snapshots).flatMap((group) => {
    const row = pick(group.filter(hasBothRefs));
    const settled = group.at(-1);
    return row && settled ? [{ row, settledMessageId: settled.message_id }] : [];
  });
}

/**
 * All turns' source, filtered row by row like the server's cumulative diff: from the first turn with
 * a usable attempt to the last. Any attempt's message id resolves to its whole turn on the server.
 */
export function allTurnsRevertSource(snapshots: readonly TurnSnapshot[], turns: readonly ReviewTurn[] | undefined): FileRevertSource | null {
  const first = turnEnds(snapshots, (rows) => rows[0])[0];
  const last = turnEnds(snapshots, (rows) => rows.at(-1)).at(-1);
  if (!first || !last || !turns) return null;
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
