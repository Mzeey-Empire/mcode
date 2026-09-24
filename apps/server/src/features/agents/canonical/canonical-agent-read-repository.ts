import type { Database } from "bun:sqlite";
import { and, asc, count, desc, eq, gt, or, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS,
  CanonicalAgentEventEnvelopeSchema,
  type AgentModelState,
  type AgentThread,
  type AgentTurn,
  type CanonicalAgentEventEnvelope,
  type CanonicalAgentReconnectRecovery,
  type CanonicalAgentRevision,
  type Message,
} from "@mcode/contracts";
import type { CanonicalAgentCheckpoint } from "./canonical-agent-event-sink.js";
import {
  CanonicalConversationProjectionReader,
  type CanonicalConversationProjection,
} from "./canonical-conversation-projection-reader.js";
import {
  canonicalAgentIngestCheckpoints,
  canonicalAgentEvents,
  canonicalAgentItems,
  canonicalAgentThreads,
  canonicalAgentTurns,
  canonicalCollaborationActions,
} from "../../../runtime/persistence/sqlite/schema.js";

export type { CanonicalConversationProjection } from "./canonical-conversation-projection-reader.js";

/** State reconstruction required by canonical reconnect reads. */
export interface CanonicalAgentReadRepositoryOperations {
  loadState(threadId: string): AgentModelState;
  mapThread(row: Record<string, unknown>): AgentThread;
  mapTurn(row: Record<string, unknown>): AgentTurn;
  mapCheckpoint(row: Record<string, unknown>): CanonicalAgentCheckpoint;
}

/** Reads canonical reconnect state without changing durable data. */
export class CanonicalAgentReadRepository {
  private readonly conversationProjection: CanonicalConversationProjectionReader;
  private readonly orm: BunSQLiteDatabase;

  constructor(
    db: Database,
    private readonly operations: CanonicalAgentReadRepositoryOperations,
  ) {
    this.orm = drizzle(db);
    this.conversationProjection = new CanonicalConversationProjectionReader(db);
  }

  /** Loads canonical conversation messages and narrative rows for a compatibility page. */
  loadConversationProjection(
    threadId: string,
    limit: number,
    before?: number,
    after?: number,
  ): CanonicalConversationProjection {
    return this.conversationProjection.load(threadId, limit, before, after);
  }

  /** Restores a replica with a contiguous delta or a replacement snapshot. */
  recoverThread(threadId: string, known: CanonicalAgentRevision): CanonicalAgentReconnectRecovery {
    const thread = this.loadThread(threadId);
    const through = {
      conversationRevision: thread?.conversationRevision ?? 0,
      rosterRevision: thread?.rosterRevision ?? 0,
    };
    if (this.requiresSnapshot(threadId, known, through)) return this.snapshot(threadId, through);
    if (this.isCurrent(known, through)) return { mode: "delta", threadId, from: known, through, events: [] };
    const events = this.eventsSince(threadId, known);
    if (!events || this.hasInboundCollaboration(threadId)) return this.snapshot(threadId, through);
    if (!this.isContiguous(events, known, through)) return this.snapshot(threadId, through);
    return { mode: "delta", threadId, from: known, through, events };
  }

  /** Loads one canonical thread. */
  loadThread(threadId: string): AgentThread | null {
    const row = this.orm.select().from(canonicalAgentThreads).where(eq(canonicalAgentThreads.id, threadId)).get();
    return row ? this.operations.mapThread(row) : null;
  }

  /** Loads one canonical turn. */
  loadTurn(turnId: string): AgentTurn | null {
    const row = this.orm.select().from(canonicalAgentTurns).where(eq(canonicalAgentTurns.id, turnId)).get();
    return row ? this.operations.mapTurn(row) : null;
  }

  /** Loads one canonical turn by its execution identity. */
  loadTurnByExecution(executionId: string): AgentTurn | null {
    const row = this.orm.select().from(canonicalAgentTurns).where(eq(canonicalAgentTurns.executionId, executionId)).get();
    return row ? this.operations.mapTurn(row) : null;
  }

  /** Loads one canonical checkpoint. */
  loadCheckpoint(executionId: string): CanonicalAgentCheckpoint | null {
    const row = this.orm.select().from(canonicalAgentIngestCheckpoints)
      .where(eq(canonicalAgentIngestCheckpoints.executionId, executionId))
      .get();
    return row ? this.operations.mapCheckpoint(row) : null;
  }

  /** Loads the durable assistant projection and tool count for one terminal turn. */
  loadTerminalProjection(turnId: string): { message: Message | null; toolCallCount: number } {
    const messageRow = this.orm.select({ payloadJson: canonicalAgentItems.payloadJson })
      .from(canonicalAgentItems)
      .where(and(
        eq(canonicalAgentItems.turnId, turnId),
        eq(canonicalAgentItems.kind, "message"),
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.projection') = 'message'`,
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.role') = 'assistant'`,
      ))
      .orderBy(desc(canonicalAgentItems.createdAt))
      .limit(1)
      .get();
    const countRow = this.orm.select({ count: count() })
      .from(canonicalAgentItems)
      .where(and(
        eq(canonicalAgentItems.turnId, turnId),
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.projection') = 'toolCall'`,
      ))
      .get();
    return {
      message: messageRow
        ? (JSON.parse(messageRow.payloadJson) as { message: Message }).message
        : null,
      toolCallCount: Number(countRow?.count ?? 0),
    };
  }

  /** Loads the accepted user message for one canonical turn. */
  loadUserMessage(turnId: string): Message | null {
    const row = this.orm.select({ payloadJson: canonicalAgentItems.payloadJson })
      .from(canonicalAgentItems)
      .where(and(
        eq(canonicalAgentItems.turnId, turnId),
        eq(canonicalAgentItems.kind, "message"),
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.projection') = 'message'`,
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.role') = 'user'`,
      ))
      .orderBy(asc(canonicalAgentItems.createdAt), asc(canonicalAgentItems.id))
      .limit(1)
      .get();
    return row ? (JSON.parse(row.payloadJson) as { message: Message }).message : null;
  }


  private snapshot(
    threadId: string,
    revision: CanonicalAgentRevision,
  ): CanonicalAgentReconnectRecovery {
    return { mode: "snapshot", threadId, snapshot: { revision, state: this.operations.loadState(threadId) } };
  }

  private requiresSnapshot(threadId: string, known: CanonicalAgentRevision, through: CanonicalAgentRevision): boolean {
    return known.conversationRevision > through.conversationRevision
      || known.rosterRevision > through.rosterRevision
      || this.hasUnfinishedNarrative(threadId);
  }

  private isCurrent(known: CanonicalAgentRevision, through: CanonicalAgentRevision): boolean {
    return known.conversationRevision === through.conversationRevision
      && known.rosterRevision === through.rosterRevision;
  }

  private hasUnfinishedNarrative(threadId: string): boolean {
    // Recovery records change without advancing the canonical event revision.
    return this.orm.select({ one: sql`1` })
      .from(canonicalAgentItems)
      .innerJoin(canonicalAgentTurns, eq(canonicalAgentTurns.id, canonicalAgentItems.turnId))
      .where(and(
        eq(canonicalAgentItems.threadId, threadId),
        sql`${canonicalAgentTurns.status} IN ('Pending', 'Running')`,
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.projection') = 'narrativeRecovery'`,
      ))
      .limit(1)
      .get() != null;
  }

  private eventsSince(
    threadId: string,
    known: CanonicalAgentRevision,
  ): CanonicalAgentEventEnvelope[] | null {
    const rows = this.orm.select({ envelopeJson: canonicalAgentEvents.envelopeJson })
      .from(canonicalAgentEvents)
      .where(and(
        eq(canonicalAgentEvents.threadId, threadId),
        or(
          gt(canonicalAgentEvents.durableRevision, known.conversationRevision),
          sql`COALESCE(${canonicalAgentEvents.rosterRevision}, 0) > ${known.rosterRevision}`,
        ),
      ))
      .orderBy(
        asc(canonicalAgentEvents.durableRevision),
        asc(canonicalAgentEvents.persistedAt),
        asc(canonicalAgentEvents.acceptedSequence),
        asc(canonicalAgentEvents.eventId),
      )
      .limit(CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS + 1)
      .all();
    if (rows.length > CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS) return null;
    return rows.map((row) => CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelopeJson)));
  }

  private hasInboundCollaboration(threadId: string): boolean {
    const row = this.orm.select({ present: sql<number>`1` })
      .from(canonicalCollaborationActions)
      .where(eq(canonicalCollaborationActions.targetThreadId, threadId))
      .limit(1)
      .get();
    return row?.present === 1;
  }

  private isContiguous(
    events: readonly CanonicalAgentEventEnvelope[],
    known: CanonicalAgentRevision,
    through: CanonicalAgentRevision,
  ): boolean {
    return this.hasContiguousRevisions(
      events.map((event) => event.durableRevision),
      known.conversationRevision,
      through.conversationRevision,
    ) && this.hasContiguousRevisions(
      events.flatMap((event) => event.rosterRevision === undefined ? [] : [event.rosterRevision]),
      known.rosterRevision,
      through.rosterRevision,
    );
  }

  private hasContiguousRevisions(values: readonly number[], from: number, through: number): boolean {
    if (from === through) return true;
    const revisions = [...new Set(values)].sort((left, right) => left - right);
    if (revisions.length === 0 || revisions[0] !== from + 1) return false;
    return revisions[revisions.length - 1] === through;
  }
}
