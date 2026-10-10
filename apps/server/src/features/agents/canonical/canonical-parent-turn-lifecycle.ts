import type { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";
import {
  canonicalAgentIngestCheckpoints,
  messages,
} from "../../../runtime/persistence/sqlite/schema.js";
import { CANONICAL_AGENT_EVENT_BATCH_MAX } from "@mcode/contracts";
import type {
  AgentThread,
  AgentTurn,
  Message,
  ParentNarrativeRecoveryItem,
} from "@mcode/contracts";
import type {
  ParentTurnFinishInput as CanonicalParentTurnFinishInput,
  ParentTurnInterruptionInput,
  ParentTurnProjection as CanonicalParentTurnProjection,
  ParentTurnStartInput,
} from "../turns/parent-turn-durability.js";
import type {
  CanonicalAgentCheckpoint,
  CanonicalAgentCommitInput,
  CanonicalAgentCommitResult,
  CanonicalAgentEventDraft,} from "./canonical-agent-boundary.js";

/** Canonical alias for the parent-turn start durability input. */
export type CanonicalParentTurnStartInput = ParentTurnStartInput;

/** Recovered narrative materializes in slices that stay under the canonical event batch cap. */
const INTERRUPTED_NARRATIVE_COMMIT_CHUNK = CANONICAL_AGENT_EVENT_BATCH_MAX / 2;

/** Durable operations required by the parent-turn lifecycle. */
export interface CanonicalParentTurnLifecycleOperations {
  commit(input: CanonicalAgentCommitInput): CanonicalAgentCommitResult;
  parentTurnStartEvents(
    input: CanonicalParentTurnStartInput,
    userMessage: Message,
    startedAt: string,
    attemptOf: string | null,
  ): CanonicalAgentEventDraft[];
  parentTurnTerminalEvents(
    input: CanonicalParentTurnFinishInput,
    projection: CanonicalParentTurnProjection | null,
    endedAt: string,
  ): CanonicalAgentEventDraft[];
  cacheExecution(executionId: string, turnId: string): void;
  loadTurn(turnId: string): AgentTurn | null;
  loadCheckpoint(executionId: string): CanonicalAgentCheckpoint | null;
  loadTurnByExecution(executionId: string): AgentTurn | null;
  loadThread(threadId: string): AgentThread | null;
  loadTerminalProjection(turnId: string): { message: Message | null };
  interruptedNarrativeEvents(input: {
    checkpoint: CanonicalAgentCheckpoint;
    thread: AgentThread;
    executionId: string;
    narrative: readonly ParentNarrativeRecoveryItem[];
    endedAt: string;
  }): CanonicalAgentEventDraft[];
  stampRecoveryIncident(executionId: string, recoveryIncidentId: string): void;
}

/** Canonical alias for the parent-turn interruption durability input. */
export type CanonicalParentTurnInterruptionInput = ParentTurnInterruptionInput;

/** Coordinates start and terminal decisions for one parent execution. */
export class CanonicalParentTurnLifecycle {
  private readonly orm: BunSQLiteDatabase;

  constructor(
    db: Database,
    private readonly operations: CanonicalParentTurnLifecycleOperations,
  ) {
    this.orm = drizzle(db);
  }

  /** Starts one parent execution and atomically projects its user message. */
  start(input: CanonicalParentTurnStartInput): CanonicalAgentCommitResult {
    let userMessage: Message | null = null;
    let attemptOf: string | null = null;
    const startedAt = new Date().toISOString();
    const result = this.operations.commit({
      threadId: input.thread.id,
      turnId: input.turnId,
      executionId: input.executionId,
      phase: "running",
      nativeCursor: input.providerIdentities.find((identity) => identity.provenance === "native"),
      replayGuard: "execution-started",
      projectCompatibility: () => {
        if (input.retryOfExecutionId) {
          const replaced = this.operations.loadTurnByExecution(input.retryOfExecutionId);
          if (!replaced || replaced.threadId !== input.thread.id) throw new Error("Retry turn not found in this thread");
          attemptOf = replaced.attemptOf ?? replaced.id;
        }
        this.consumeRetry(input.retryOfExecutionId, startedAt);
        userMessage = input.projectUserMessage();
      },
      events: () => {
        if (!userMessage) throw new Error("Canonical user-message projection did not produce a row");
        return this.operations.parentTurnStartEvents(input, userMessage, startedAt, attemptOf);
      },
    });
    this.operations.cacheExecution(input.executionId, input.turnId);
    return result;
  }

  /** Commits the first terminal decision with its canonical and compatibility projections. */
  finish(input: CanonicalParentTurnFinishInput): CanonicalAgentCommitResult {
    let projection: CanonicalParentTurnProjection | null = null;
    const endedAt = new Date().toISOString();
    return this.operations.commit({
      threadId: input.threadId,
      turnId: input.turnId,
      executionId: input.executionId,
      phase: input.outcome,
      terminalOutcome: input.outcome,
      error: input.error,
      nativeCursor: input.providerIdentities.find((identity) => identity.provenance === "native"),
      replayGuard: "terminal-confirmed",
      projectCompatibility: () => {
        projection = input.projectTurn();
      },
      events: () => this.operations.parentTurnTerminalEvents(input, projection, endedAt),
    });
  }

  /** Interrupts only an execution that has no durable terminal decision. */
  interrupt(input: CanonicalParentTurnInterruptionInput): CanonicalAgentCommitResult {
    const context = this.unfinishedContext(input.executionId);
    this.assertStagedAssistant(input.stagedAssistant, context.checkpoint, input.executionId);
    const endedAt = input.endedAt ?? new Date().toISOString();
    const recoveryProjection = this.recoveryProjection(
      input.stagedAssistant ?? this.operations.loadTerminalProjection(context.checkpoint.turnId).message,
      input.executionId,
    );
    const narrative = this.recoveredNarrative(
      input.recoveredNarrative ?? [],
      recoveryProjection,
      endedAt,
      input.executionId,
    );
    this.commitInterruptedNarrative(context, narrative, endedAt);
    return this.operations.commit(this.interruptionCommit(
      input,
      context,
      recoveryProjection,
      narrative,
      endedAt,
    ));
  }

  /**
   * Materializes recovered narrative in bounded running commits so the terminal
   * interruption always fits one canonical batch. Materialized items leave the
   * recovery snapshot, so a mid-loop restart resumes with only what remains.
   */
  private commitInterruptedNarrative(
    context: { checkpoint: CanonicalAgentCheckpoint; thread: AgentThread },
    narrative: readonly ParentNarrativeRecoveryItem[],
    endedAt: string,
  ): void {
    for (let offset = 0; offset < narrative.length; offset += INTERRUPTED_NARRATIVE_COMMIT_CHUNK) {
      const result = this.operations.commit({
        threadId: context.checkpoint.threadId,
        turnId: context.checkpoint.turnId,
        executionId: context.checkpoint.executionId,
        phase: "running",
        events: this.operations.interruptedNarrativeEvents({
          checkpoint: context.checkpoint,
          thread: context.thread,
          executionId: context.checkpoint.executionId,
          narrative: narrative.slice(offset, offset + INTERRUPTED_NARRATIVE_COMMIT_CHUNK),
          endedAt,
        }),
      });
      if (result.outcome !== "committed" && result.outcome !== "duplicate") {
        throw new Error(`Interrupted narrative was not committed: ${context.checkpoint.executionId}`);
      }
    }
  }

  private unfinishedContext(executionId: string): {
    checkpoint: CanonicalAgentCheckpoint;
    thread: AgentThread;
  } {
    const checkpoint = this.operations.loadCheckpoint(executionId);
    const turn = this.operations.loadTurnByExecution(executionId);
    if (!checkpoint || !turn) throw new Error(`Canonical execution not found: ${executionId}`);
    if (checkpoint.terminalOutcome || !["Pending", "Running"].includes(turn.status)) {
      throw new Error(`Canonical execution is not unfinished: ${executionId}`);
    }
    const thread = this.operations.loadThread(checkpoint.threadId);
    if (!thread) throw new Error(`Canonical thread not found: ${checkpoint.threadId}`);
    return { checkpoint, thread };
  }

  private assertStagedAssistant(
    assistant: Message | undefined,
    checkpoint: CanonicalAgentCheckpoint,
    executionId: string,
  ): void {
    if (!assistant) return;
    if (assistant.thread_id === checkpoint.threadId && assistant.role === "assistant") return;
    throw new Error(`Recovered assistant projection does not belong to execution: ${executionId}`);
  }

  private recoveryProjection(assistant: Message | null, executionId: string): Message | null {
    if (!assistant) return null;
    return {
      ...assistant,
      is_internal: false,
      outcome: "interrupted",
      outcomeExecutionId: executionId,
    };
  }

  private recoveredNarrative(
    recoveredNarrative: readonly ParentNarrativeRecoveryItem[],
    assistant: Message | null,
    endedAt: string,
    executionId: string,
  ): ParentNarrativeRecoveryItem[] {
    if (recoveredNarrative.length === 0) return [];
    if (!assistant) throw new Error(`Recovered narrative has no assistant projection: ${executionId}`);
    return this.reconcileInterruptedNarrative(recoveredNarrative, assistant.id, endedAt);
  }

  private interruptionCommit(
    input: CanonicalParentTurnInterruptionInput,
    context: { checkpoint: CanonicalAgentCheckpoint; thread: AgentThread },
    assistant: Message | null,
    narrative: readonly ParentNarrativeRecoveryItem[],
    endedAt: string,
  ): CanonicalAgentCommitInput {
    return {
      threadId: context.checkpoint.threadId,
      turnId: context.checkpoint.turnId,
      executionId: input.executionId,
      phase: "interrupted",
      terminalOutcome: "interrupted",
      error: input.reason,
      nativeCursor: context.checkpoint.nativeCursor ?? undefined,
      projectCompatibility: () => {
        this.projectInterruption(input, assistant, narrative);
        if (input.recoveryIncidentId) {
          this.operations.stampRecoveryIncident(input.executionId, input.recoveryIncidentId);
        }
      },
      events: () => this.interruptionEvents(input.reason, context, assistant, endedAt),
    };
  }

  private projectInterruption(
    input: CanonicalParentTurnInterruptionInput,
    assistant: Message | null,
    narrative: readonly ParentNarrativeRecoveryItem[],
  ): void {
    if (!assistant) return;
    const updated = runChanges(this.orm.update(messages)
      .set({ isInternal: 0, outcome: "interrupted", outcomeExecutionId: input.executionId })
      .where(and(eq(messages.id, assistant.id), eq(messages.role, "assistant"))));
    if (input.stagedAssistant && updated.changes !== 1) {
      throw new Error(`Recovered assistant message was not staged: ${assistant.id}`);
    }
    input.finalizeCompatibility?.(assistant, narrative);
  }

  private interruptionEvents(
    reason: string,
    context: { checkpoint: CanonicalAgentCheckpoint; thread: AgentThread },
    assistant: Message | null,
    endedAt: string,
  ): CanonicalAgentEventDraft[] {
    const { checkpoint, thread } = context;
    return [
      this.idleEvent(checkpoint, thread, endedAt),
      ...this.assistantEvent(checkpoint, thread, assistant, endedAt),
      this.interruptedEvent(checkpoint, thread, reason, endedAt),
    ];
  }

  private idleEvent(
    checkpoint: CanonicalAgentCheckpoint,
    thread: AgentThread,
    endedAt: string,
  ): CanonicalAgentEventDraft {
    return {
      eventId: `${checkpoint.executionId}:recovery-thread-idle`,
      routing: { threadId: checkpoint.threadId, executionId: checkpoint.executionId },
      sourceProviderId: thread.providerId,
      sourceIdentities: thread.providerIdentities,
      payload: {
        type: "thread.recorded",
        thread: { ...thread, activityState: "Idle", updatedAt: endedAt },
      },
    };
  }

  private assistantEvent(
    checkpoint: CanonicalAgentCheckpoint,
    thread: AgentThread,
    assistant: Message | null,
    endedAt: string,
  ): CanonicalAgentEventDraft[] {
    if (!assistant) return [];
    return [{
      eventId: `${checkpoint.executionId}:recovery-assistant-outcome:${assistant.id}`,
      routing: {
        threadId: checkpoint.threadId,
        turnId: checkpoint.turnId,
        executionId: checkpoint.executionId,
        itemId: `message:${assistant.id}`,
      },
      sourceProviderId: thread.providerId,
      sourceIdentities: thread.providerIdentities,
      payload: {
        type: "item.recorded",
        item: {
          id: `message:${assistant.id}`,
          threadId: checkpoint.threadId,
          turnId: checkpoint.turnId,
          kind: "message",
          providerIdentities: thread.providerIdentities,
          payload: { projection: "message", message: assistant },
          createdAt: assistant.timestamp,
          updatedAt: endedAt,
        },
      },
    }];
  }

  private interruptedEvent(
    checkpoint: CanonicalAgentCheckpoint,
    thread: AgentThread,
    reason: string,
    endedAt: string,
  ): CanonicalAgentEventDraft {
    return {
      eventId: `${checkpoint.executionId}:recovery-interrupted`,
      routing: {
        threadId: checkpoint.threadId,
        turnId: checkpoint.turnId,
        executionId: checkpoint.executionId,
      },
      sourceProviderId: thread.providerId,
      sourceIdentities: thread.providerIdentities,
      payload: { type: "turn.interrupted", endedAt, reason },
    };
  }

  private reconcileInterruptedNarrative(
    items: readonly ParentNarrativeRecoveryItem[],
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem[] {
    return items.map((item) => this.reconciledNarrativeItem(item, messageId, endedAt));
  }

  private reconciledNarrativeItem(
    item: ParentNarrativeRecoveryItem,
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem {
    if (item.kind === "toolCall") return this.reconciledToolCall(item, messageId, endedAt);
    if (item.kind === "hook") return this.reconciledHook(item, messageId, endedAt);
    return { kind: "narrationSegment", record: { ...item.record, message_id: messageId } };
  }

  private reconciledToolCall(
    item: Extract<ParentNarrativeRecoveryItem, { kind: "toolCall" }>,
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem {
    return {
      kind: "toolCall",
      record: {
        ...item.record,
        message_id: messageId,
        ...(item.record.status === "running" ? { status: "failed", completed_at: endedAt } : {}),
      },
    };
  }

  private reconciledHook(
    item: Extract<ParentNarrativeRecoveryItem, { kind: "hook" }>,
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem {
    const durationMs = item.record.ended_at
      ? item.record.duration_ms
      : Math.max(0, Date.parse(endedAt) - Date.parse(item.record.started_at));
    return {
      kind: "hook",
      record: {
        ...item.record,
        message_id: messageId,
        duration_ms: durationMs,
        ended_at: item.record.ended_at ?? endedAt,
      },
    };
  }

  private consumeRetry(retryOfExecutionId: string | undefined, updatedAt: string): void {
    if (!retryOfExecutionId) return;
    const consumed = runChanges(this.orm.update(canonicalAgentIngestCheckpoints)
      .set({ phase: "retried", updatedAt })
      .where(and(
        eq(canonicalAgentIngestCheckpoints.executionId, retryOfExecutionId),
        inArray(canonicalAgentIngestCheckpoints.phase, ["interrupted", "errored"]),
        inArray(canonicalAgentIngestCheckpoints.terminalOutcome, ["interrupted", "errored"]),
      )));
    if (consumed.changes !== 1) throw new Error(`Interrupted execution not found: ${retryOfExecutionId}`);
  }
}
