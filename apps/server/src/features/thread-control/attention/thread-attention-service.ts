import type { Database } from "bun:sqlite";
import { hasUnseenRestartFailure, isTurnSeen, RestartFailureSchema, ThreadAttentionSchema, threadHasRunningDescendants, type ThreadAttention, type ThreadWaitingKind } from "@mcode/contracts/models/thread-attention";
import { restartFailureNoticeSql } from "./restart-failure-notice-sql.js";
import { type CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { threadWriteOperations } from "../persistence/thread-write-operations.js";
import type { DelegatedTaskService } from "../delegation/delegated-task-service.js";
import type { AgentWorkload } from "../../agents/workload/agent-workload.js";

/** Supplies live waits on their owning threads, with the earliest request time. */
export interface ThreadWaitingSource {
  readonly kind: ThreadWaitingKind;
  listWaiting(): ReadonlyMap<string, string>;
}

/** Supplies Coordinators whose delegated tasks are currently working or waiting. */
export interface ThreadDelegationSource {
  coordinatorsWithUnfinishedTasks(coordinatorThreadId?: string): ReadonlySet<string>;
}

const waitingPrecedence: readonly ThreadWaitingKind[] = ["approval", "questions", "plan"];
const attentionSelect = `SELECT t.id AS threadId, t.seen_through_sequence AS seenSequence,
  t.seen_at AS seenAt, t.last_turn_outcome AS outcome, t.last_turn_ended_at AS endedAt,
  t.last_turn_sequence AS sequence,
  (SELECT json_extract(s.file_effects, '$.fileCount') FROM turn_snapshots s
    JOIN messages m ON m.id = s.message_id
    WHERE s.thread_id = t.id AND m.sequence = t.last_turn_sequence LIMIT 1) AS changedFileCount,
  (SELECT json_object('sequence', m.sequence, 'at', m.timestamp) FROM messages m
    WHERE m.thread_id = t.id AND m.sequence > COALESCE(t.last_turn_sequence, -1) AND ${restartFailureNoticeSql("m")}
    ORDER BY m.sequence DESC LIMIT 1) AS restartFailure
  FROM threads t WHERE t.deleted_at IS NULL`;

type AttentionRow = {
  threadId: string; seenSequence: number | null; seenAt: string | null;
  outcome: string | null; endedAt: string | null; sequence: number | null; changedFileCount: number | null;
  /** JSON `{ sequence, at }` of the newest failure notice after the last turn; the bound keeps the scan on the index. */
  restartFailure: string | null;
};

/**
 * A restart failure alerts only when it is newer than the last settled turn. A failure before admission leaves
 * that turn interrupted (resume) or completed (wake), so an errored last turn is the attempt itself and already
 * alerted, whether or not it has been seen since.
 */
function restartFailureOf(row: AttentionRow): ThreadAttention["restartFailure"] {
  if (row.restartFailure === null || row.outcome === "errored") return null;
  return RestartFailureSchema().parse(JSON.parse(row.restartFailure));
}

/** Combines durable outcomes and acknowledgements with live waiting sources. */
export class ThreadAttentionService {
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly lastSent = new Map<string, string>();
  private readonly sources: readonly ThreadWaitingSource[];

  constructor(
    private readonly db: Database,
    private readonly writer: ApplicationDatabaseWriter,
    sources: readonly ThreadWaitingSource[],
    private readonly delegations: ThreadDelegationSource,
    private readonly subagents: Pick<AgentWorkload, "backgroundSubagentThreadIds">,
    private readonly publish: (attention: ThreadAttention) => void,
  ) {
    this.sources = waitingPrecedence.flatMap((kind) => sources.filter((source) => source.kind === kind));
  }

  /** Observe changed attention after it has been published to clients. */
  onPublished(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Read attention for a live thread, including one whose outcome is already seen. */
  get(threadId: string): ThreadAttention | null {
    const row = this.db.query<AttentionRow, [string]>(`${attentionSelect} AND t.id = ?`).get(threadId);
    if (!row) return null;
    return this.fromRow(row, this.waiting(), this.delegations.coordinatorsWithUnfinishedTasks(threadId).has(threadId),
      this.subagents.backgroundSubagentThreadIds());
  }

  /** Hydrate live threads with a wait, delegated work, a background subagent, or an unseen settled turn. */
  listInteresting(): ThreadAttention[] {
    const waiting = this.waiting();
    const coordinators = this.delegations.coordinatorsWithUnfinishedTasks();
    const withSubagents = this.subagents.backgroundSubagentThreadIds();
    return this.db.query<AttentionRow, []>(attentionSelect).all()
      .map((row) => this.fromRow(row, waiting, coordinators.has(row.threadId), withSubagents))
      .filter((attention) => attention.waiting !== null || threadHasRunningDescendants(attention) || hasUnseenRestartFailure(attention)
        || attention.lastTurn !== null && !isTurnSeen(attention.lastTurn.sequence, attention.seen.sequence));
  }

  /** Broadcast a changed read model to every client, including background threads. */
  invalidate(threadId: string): void {
    const attention = this.get(threadId);
    if (!attention) { this.lastSent.delete(threadId); return; }
    const serialized = JSON.stringify(attention);
    if (this.lastSent.get(threadId) === serialized) return;
    this.lastSent.set(threadId, serialized);
    this.publish(attention);
    for (const listener of this.listeners) listener(threadId);
  }

  /** Atomically acknowledge a rendered server sequence up to a settled turn boundary. */
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

  private fromRow(
    row: AttentionRow, waiting: ReturnType<ThreadAttentionService["waiting"]>, hasUnfinishedDelegatedTasks: boolean,
    withSubagents: ReadonlySet<string>,
  ): ThreadAttention {
    return ThreadAttentionSchema().parse({
      threadId: row.threadId, waiting: waiting.get(row.threadId) ?? null,
      hasUnfinishedDelegatedTasks,
      hasRunningBackgroundSubagents: withSubagents.has(row.threadId),
      lastTurn: row.outcome === null || row.sequence === null ? null : {
        outcome: row.outcome, endedAt: row.endedAt, sequence: row.sequence, changedFileCount: row.changedFileCount,
      },
      seen: { sequence: row.seenSequence, at: row.seenAt },
      restartFailure: restartFailureOf(row),
    });
  }
}

/** Committed lifecycle events whose turns no longer have active work. */
export const settledTurnEvents: ReadonlySet<string> = new Set(["turn.completed", "turn.errored", "turn.cancelled", "turn.interrupted"]);

/** Refresh delegated task projections when their original child turn settles durably. */
export function notifyTasksOnSettledTurns(
  tasks: Pick<DelegatedTaskService, "taskChanged">,
  subscribe: (listener: (events: readonly CanonicalAgentEventEnvelope[]) => void) => () => void,
): () => void {
  return subscribe((events) => {
    for (const event of events) {
      if (settledTurnEvents.has(event.payload.type) && event.routing.turnId) tasks.taskChanged(event.routing.turnId);
    }
  });
}

/**
 * Accepted executions settle through saved canonical batches and never release a committed AgentEvent,
 * so attention follows the same durable signal every client renders from.
 */
export function invalidateAttentionOnSettledTurns(
  attention: Pick<ThreadAttentionService, "invalidate">,
  subscribe: (listener: (events: readonly CanonicalAgentEventEnvelope[]) => void) => () => void,
): () => void {
  return subscribe((events) => {
    const settled = new Set(events.flatMap((event) => settledTurnEvents.has(event.payload.type) ? [event.routing.threadId] : []));
    for (const threadId of settled) attention.invalidate(threadId);
  });
}

/** Background subagents start and finish outside their parent's turn, so no settled turn event refreshes the parent's attention. */
export function invalidateAttentionOnSubagentChange(
  attention: Pick<ThreadAttentionService, "invalidate">,
  workload: Pick<AgentWorkload, "onSubagentChange">,
): () => void {
  return workload.onSubagentChange((threadId) => attention.invalidate(threadId));
}
