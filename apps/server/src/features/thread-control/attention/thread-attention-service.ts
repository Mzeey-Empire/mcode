import type { Database } from "bun:sqlite";
import { ThreadAttentionSchema, type ThreadAttention, type ThreadWaitingKind } from "@mcode/contracts";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { threadWriteOperations } from "../persistence/thread-write-operations.js";

/** Supplies live waits on their owning threads, with the earliest request time. */
export interface ThreadWaitingSource {
  readonly kind: ThreadWaitingKind;
  listWaiting(): ReadonlyMap<string, string>;
}

const waitingPrecedence: readonly ThreadWaitingKind[] = ["approval", "questions", "plan"];
const attentionSelect = `SELECT t.id AS threadId, t.seen_through_sequence AS seenSequence,
  t.seen_at AS seenAt, t.last_turn_outcome AS outcome, t.last_turn_ended_at AS endedAt,
  t.last_turn_sequence AS sequence,
  (SELECT json_extract(s.file_effects, '$.fileCount') FROM turn_snapshots s
    JOIN messages m ON m.id = s.message_id
    WHERE s.thread_id = t.id AND m.sequence = t.last_turn_sequence LIMIT 1) AS changedFileCount
  FROM threads t WHERE t.deleted_at IS NULL`;

type AttentionRow = {
  threadId: string; seenSequence: number | null; seenAt: string | null;
  outcome: string | null; endedAt: string | null; sequence: number | null; changedFileCount: number | null;
};

/** Combines durable outcomes and acknowledgements with live waiting sources. */
export class ThreadAttentionService {
  private readonly lastSent = new Map<string, string>();
  private readonly sources: readonly ThreadWaitingSource[];

  constructor(
    private readonly db: Database,
    private readonly writer: ApplicationDatabaseWriter,
    sources: readonly ThreadWaitingSource[],
    private readonly publish: (attention: ThreadAttention) => void,
  ) {
    this.sources = waitingPrecedence.flatMap((kind) => sources.filter((source) => source.kind === kind));
  }

  /** Read attention for a live thread, including one whose outcome is already seen. */
  get(threadId: string): ThreadAttention | null {
    const row = this.db.query<AttentionRow, [string]>(`${attentionSelect} AND t.id = ?`).get(threadId);
    return row ? this.fromRow(row, this.waiting()) : null;
  }

  /** Hydrate only live threads with a wait or an unseen settled turn. */
  listInteresting(): ThreadAttention[] {
    const waiting = this.waiting();
    return this.db.query<AttentionRow, []>(attentionSelect).all()
      .map((row) => this.fromRow(row, waiting))
      .filter(({ waiting, lastTurn, seen }) => waiting !== null
        || lastTurn !== null && (seen.sequence === null || seen.sequence < lastTurn.sequence));
  }

  /** Broadcast a changed read model to every client, including background threads. */
  invalidate(threadId: string): void {
    const attention = this.get(threadId);
    if (!attention) { this.lastSent.delete(threadId); return; }
    const serialized = JSON.stringify(attention);
    if (this.lastSent.get(threadId) === serialized) return;
    this.lastSent.set(threadId, serialized);
    this.publish(attention);
  }

  /** Atomically acknowledge precisely the settled sequence rendered by the client. */
  async acknowledgeSeen(threadId: string, throughSequence: number) {
    const result = await this.writer.execute(threadWriteOperations.acknowledgeSeen, [threadId, throughSequence]);
    if (result.previous.sequence !== result.current.sequence) this.invalidate(threadId);
    return result;
  }

  private waiting(): ReadonlyMap<string, NonNullable<ThreadAttention["waiting"]>> {
    const waiting = new Map<string, NonNullable<ThreadAttention["waiting"]>>();
    for (const source of this.sources) {
      for (const [threadId, since] of source.listWaiting()) {
        if (!waiting.has(threadId)) waiting.set(threadId, { kind: source.kind, since });
      }
    }
    return waiting;
  }

  private fromRow(row: AttentionRow, waiting: ReturnType<ThreadAttentionService["waiting"]>): ThreadAttention {
    return ThreadAttentionSchema().parse({
      threadId: row.threadId, waiting: waiting.get(row.threadId) ?? null,
      lastTurn: row.outcome === null || row.sequence === null ? null : {
        outcome: row.outcome, endedAt: row.endedAt, sequence: row.sequence, changedFileCount: row.changedFileCount,
      },
      seen: { sequence: row.seenSequence, at: row.seenAt },
    });
  }
}
