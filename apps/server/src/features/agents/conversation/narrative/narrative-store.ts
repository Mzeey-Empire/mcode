import { NarrativeReadStore } from "./narrative-read-store.js";
/**
 * NarrativeStore — single home for the narrative pipeline's read side (and,
 * after the candidate-A write-seam extraction, its enrichment + classification
 * + persistence too).
 *
 * Read seam: {@link NarrativeStore.load} returns one chronologically-ordered
 * list of {@link NarrativeEntry} for a thread, interleaving assistant message
 * bodies, tool calls, narration segments, and hooks by (sequence, sortOrder).
 * The client renders this list in payload order, so reloaded turns no longer
 * race two hydration streams (the old `message.list` + `narrative.list` pair)
 * and Tool calls never render before the assistant message body.
 *
 * Write seam: NarrativeTurnState owns the per-turn buffers (tool calls, the
 * `agentCallStack`, the open/closed thought segments, hook executions, and the
 * shared sort counter). This store adds SQLite persistence and applies emitted
 * data-only effects. The six narrative-pipeline traps documented in
 * `docs/internals/conversation/narrative-pipeline.md` are enforced here:
 *
 * - Trap 1: {@link bufferToolCall} prefers the SDK `parent_tool_use_id` and only
 *   falls back to {@link getCurrentParentToolCallId} when exactly one Agent on
 *   the stack is still running.
 * - Trap 2: the `agentCallStack` is mutated only by {@link bufferToolCall}
 *   (push on Agent), {@link updateBufferedToolCallOutput} (pop on Agent result),
 *   and {@link clearAgentStackOnMessage} (clear at end of turn). Never on
 *   textDelta — the textDelta thought handling in {@link openOrExtendThought}
 *   never touches the stack.
 * - Trap 3: the volatile buffers are reset at turn start ({@link beginTurn} +
 *   {@link resetTurnCounters}) and survive through {@link persistNarrative};
 *   they are cleared only by {@link clearTurn}.
 * - Classification precedence + the `is_final_response` suffix-match safety net
 *   live in {@link dropOpenThought}/{@link closeOpenThought} and
 *   {@link persistNarrative}.
 * - Trap 6: counting semantics are owned by the client; this store preserves
 *   the persisted rows verbatim and changes no counts.
 */
import { injectable, inject } from "tsyringe";
import { rosterToolCall, type RosterToolCall } from "../../collaboration/subagent-roster-projection.js";
import type { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  hookExecutions,
  messages,
  thoughtSegments,
  toolCallRecords,
} from "../../../../runtime/persistence/sqlite/schema.js";
import { logger } from "@mcode/shared";
import {
  NarrativeEntrySchema,
  type Message,
  type NarrativeEntry,
  type NarrativeDetailCursor,
  type ParentNarrativeRecoveryItem,
  type TurnRange,
  type ToolCallRecord,
} from "@mcode/contracts";
import { MessageRepo } from "../persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "./persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import type { TurnOutcome } from "../../turns/turn-outcome.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import {
  NarrativeTurnState,
  type PreparedNarrativePersistence,
  type NarrativeTurnStateEffect,
} from "./narrative-turn-state.js";
export type {
  BufferedToolCall,
  BufferToolCallEvent,
  OpenHook,
  StagedNarrationSegment,
} from "./narrative-turn-state.js";

/** Default number of recent messages hydrated when no range is supplied. */
const DEFAULT_LOAD_LIMIT = 200;
const DEFAULT_DETAIL_LOAD_LIMIT = 100;
const ASSISTANT_BODY_SORT_ORDER = Number.MAX_SAFE_INTEGER;

type SelectedNarrativeMessageRow = {
  id: string;
  sequence: number;
  role: string;
  content: string;
};

function narrativeKindOrder(kind: NarrativeDetailCursor["kind"]): number {
  switch (kind) {
    case "assistantMessage": return 0;
    case "toolCall": return 1;
    case "narrationSegment": return 2;
    case "hook": return 3;
  }
}

function narrativeEntryId(entry: NarrativeEntry): string {
  switch (entry.kind) {
    case "assistantMessage": return entry.messageId;
    case "toolCall": return entry.record.id;
    case "narrationSegment": return entry.record.id;
    case "hook": return entry.record.id;
  }
}

/** SQLite's BINARY collation compares the UTF-8 byte representation of text IDs. */
function compareSqliteBinaryIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareNarrativeEntries(left: NarrativeEntry, right: NarrativeEntry): number {
  return left.sequence - right.sequence
    || left.sortOrder - right.sortOrder
    || narrativeKindOrder(left.kind) - narrativeKindOrder(right.kind)
    || compareSqliteBinaryIds(narrativeEntryId(left), narrativeEntryId(right));
}

/** Result of persisting a turn's narrative rows. */
export interface PersistNarrativeResult {
  /** Number of buffered tool calls written (drives the turn.persisted count). */
  toolCallCount: number;
}

interface PendingNarrativePersistence extends PreparedNarrativePersistence {}

interface PersistedNarrativeRows {
  toolCalls: Set<string>;
  thoughts: Set<string>;
  hooks: Set<string>;
}



@injectable()
export class NarrativeStore {
  /** Read persisted calls with their original message provider, overlaid by the active turn. */
  loadSubagentCalls(threadId: string): RosterToolCall[] {
    if (!this.db) throw new Error("Subagent reads require the narrative database");
    const records = this.db.prepare<ToolCallRecord & { provider: string | null; outcome: string | null }, [string, string]>(`
      WITH RECURSIVE subagent_calls(id) AS (
        SELECT tool.id FROM messages AS owner
        JOIN tool_call_records AS tool ON tool.message_id = owner.id
        WHERE owner.thread_id = ? AND tool.tool_name = 'Agent'
        UNION
        SELECT child.id FROM subagent_calls AS parent
        JOIN tool_call_records AS child ON child.parent_tool_call_id = parent.id
        JOIN messages AS owner ON owner.id = child.message_id
        WHERE owner.thread_id = ?
      )
      SELECT tool.*, owner.provider, owner.outcome FROM subagent_calls
      JOIN tool_call_records AS tool ON tool.id = subagent_calls.id
      JOIN messages AS owner ON owner.id = tool.message_id
    `).all(threadId, threadId);
    const buffered = this.getBufferedToolCalls(threadId);
    const messageIds = [...new Set(buffered.map((call) => call.messageId).filter(Boolean))];
    const messageRows = messageIds.length === 0 ? [] : drizzle(this.db).select({
      id: messages.id, provider: messages.provider, outcome: messages.outcome,
    }).from(messages).where(and(eq(messages.threadId, threadId), inArray(messages.id, messageIds))).all();
    const calls = new Map(records.map((record) => [record.id, rosterToolCall(record, record.provider, record.outcome)]));
    const owners = new Map(messageRows.map((message) => [message.id, message]));
    buffered.forEach((call) => {
      if (!call.toolCallId || !call.startedAt) return;
      const saved = calls.get(call.toolCallId) ?? { messageId: "", provider: null, parentStopped: false };
      const owner = owners.get(call.messageId);
      calls.set(call.toolCallId, {
        ...call, toolCallId: call.toolCallId, startedAt: call.startedAt,
        messageId: call.messageId || saved.messageId,
        provider: owner?.provider ?? saved.provider,
        parentStopped: saved.parentStopped || ["cancelled", "interrupted"].includes(owner?.outcome ?? ""),
        presentation: call._subagentPresentation,
      });
    });
    return [...calls.values()].sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.sortOrder - right.sortOrder);
  }

  /** Check for roster work without hydrating the thread's narrative history. */
  hasSubagentCalls(threadId: string): boolean {
    if (this.getBufferedToolCalls(threadId).some((call) => call.toolName === "Agent")) return true;
    if (!this.db) throw new Error("Subagent reads require the narrative database");
    return this.db.prepare<{ id: string }, [string]>(`
      SELECT tool.id FROM messages AS owner
      JOIN tool_call_records AS tool ON tool.message_id = owner.id
      WHERE owner.thread_id = ? AND tool.tool_name = 'Agent'
      LIMIT 1
    `).get(threadId) !== null;
  }

  constructor(
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(ToolCallRecordRepo) private readonly toolCallRecordRepo: ToolCallRecordRepo,
    @inject(ThoughtSegmentRepo) private readonly thoughtSegmentRepo: ThoughtSegmentRepo,
    @inject(HookExecutionRepo) private readonly hookExecutionRepo: HookExecutionRepo,
    @inject("Database") private readonly db?: Database,
  ) {}

  private applyStateEffect(effect: NarrativeTurnStateEffect): void {
    void this.toolCallRecordRepo.updateSubagentIdentity(
      effect.toolCallId, effect.messageId, effect.identityKey,
    ).catch((error: unknown) => {
      logger.error("Failed to persist narrative subagent identity", {
        toolCallId: effect.toolCallId,
        messageId: effect.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private readonly narrativeStates = new Map<string, NarrativeTurnState>();

  private stateFor(threadId: string): NarrativeTurnState {
    const existing = this.narrativeStates.get(threadId);
    if (existing) return existing;
    const state = new NarrativeTurnState(threadId, (effect) => this.applyStateEffect(effect));
    this.narrativeStates.set(threadId, state);
    return state;
  }

  beginTurn(...args: Parameters<NarrativeTurnState["beginTurn"]>): ReturnType<NarrativeTurnState["beginTurn"]> {
    return this.stateFor(args[0]).beginTurn(...args);
  }

  resetTurnCounters(...args: Parameters<NarrativeTurnState["resetTurnCounters"]>): ReturnType<NarrativeTurnState["resetTurnCounters"]> {
    return this.stateFor(args[0]).resetTurnCounters(...args);
  }

  nextSortOrder(...args: Parameters<NarrativeTurnState["nextSortOrder"]>): ReturnType<NarrativeTurnState["nextSortOrder"]> {
    return this.stateFor(args[0]).nextSortOrder(...args);
  }

  openOrExtendThought(...args: Parameters<NarrativeTurnState["openOrExtendThought"]>): ReturnType<NarrativeTurnState["openOrExtendThought"]> {
    return this.stateFor(args[0]).openOrExtendThought(...args);
  }

  settleAssistantTextItem(...args: Parameters<NarrativeTurnState["settleAssistantTextItem"]>): ReturnType<NarrativeTurnState["settleAssistantTextItem"]> {
    return this.stateFor(args[0]).settleAssistantTextItem(...args);
  }

  closeOpenThought(...args: Parameters<NarrativeTurnState["closeOpenThought"]>): ReturnType<NarrativeTurnState["closeOpenThought"]> {
    this.narrativeStates.get(args[0])?.closeOpenThought(...args);
  }

  dropOpenThought(...args: Parameters<NarrativeTurnState["dropOpenThought"]>): ReturnType<NarrativeTurnState["dropOpenThought"]> {
    this.narrativeStates.get(args[0])?.dropOpenThought(...args);
  }

  takeOpenThought(...args: Parameters<NarrativeTurnState["takeOpenThought"]>): ReturnType<NarrativeTurnState["takeOpenThought"]> {
    return this.narrativeStates.get(args[0])?.takeOpenThought(...args) ?? "";
  }

  getCurrentParentToolCallId(...args: Parameters<NarrativeTurnState["getCurrentParentToolCallId"]>): ReturnType<NarrativeTurnState["getCurrentParentToolCallId"]> {
    return this.narrativeStates.get(args[0])?.getCurrentParentToolCallId(...args);
  }

  bufferToolCall(...args: Parameters<NarrativeTurnState["bufferToolCall"]>): ReturnType<NarrativeTurnState["bufferToolCall"]> {
    return this.stateFor(args[0]).bufferToolCall(...args);
  }

  updateBufferedToolCallOutput(...args: Parameters<NarrativeTurnState["updateBufferedToolCallOutput"]>): ReturnType<NarrativeTurnState["updateBufferedToolCallOutput"]> {
    this.narrativeStates.get(args[0])?.updateBufferedToolCallOutput(...args);
  }

  clearAgentStackOnMessage(...args: Parameters<NarrativeTurnState["clearAgentStackOnMessage"]>): ReturnType<NarrativeTurnState["clearAgentStackOnMessage"]> {
    this.narrativeStates.get(args[0])?.clearAgentStackOnMessage(...args);
  }

  getBufferedToolCalls(...args: Parameters<NarrativeTurnState["getBufferedToolCalls"]>): ReturnType<NarrativeTurnState["getBufferedToolCalls"]> {
    return this.narrativeStates.get(args[0])?.getBufferedToolCalls(...args) ?? [];
  }

  recoverySnapshot(...args: Parameters<NarrativeTurnState["recoverySnapshot"]>): ReturnType<NarrativeTurnState["recoverySnapshot"]> {
    return this.narrativeStates.get(args[0])?.recoverySnapshot(...args) ?? [];
  }

  stageNarrationSegment(...args: Parameters<NarrativeTurnState["stageNarrationSegment"]>): ReturnType<NarrativeTurnState["stageNarrationSegment"]> {
    return (this.narrativeStates.get(args[0]) ?? new NarrativeTurnState(args[0]))
      .stageNarrationSegment(...args);
  }

  recoverySnapshotWithStagedNarration(...args: Parameters<NarrativeTurnState["recoverySnapshotWithStagedNarration"]>): ReturnType<NarrativeTurnState["recoverySnapshotWithStagedNarration"]> {
    return (this.narrativeStates.get(args[0]) ?? new NarrativeTurnState(args[0]))
      .recoverySnapshotWithStagedNarration(...args);
  }

  applyStagedNarrationSegment(...args: Parameters<NarrativeTurnState["applyStagedNarrationSegment"]>): ReturnType<NarrativeTurnState["applyStagedNarrationSegment"]> {
    return this.stateFor(args[0]).applyStagedNarrationSegment(...args);
  }

  hasBufferedNarrative(...args: Parameters<NarrativeTurnState["hasBufferedNarrative"]>): ReturnType<NarrativeTurnState["hasBufferedNarrative"]> {
    return this.narrativeStates.get(args[0])?.hasBufferedNarrative(...args) ?? false;
  }

  openHook(...args: Parameters<NarrativeTurnState["openHook"]>): ReturnType<NarrativeTurnState["openHook"]> {
    return this.stateFor(args[0]).openHook(...args);
  }

  peekOpenHook(...args: Parameters<NarrativeTurnState["peekOpenHook"]>): ReturnType<NarrativeTurnState["peekOpenHook"]> {
    return this.narrativeStates.get(args[0])?.peekOpenHook(...args);
  }

  removeOpenHook(...args: Parameters<NarrativeTurnState["removeOpenHook"]>): ReturnType<NarrativeTurnState["removeOpenHook"]> {
    this.narrativeStates.get(args[0])?.removeOpenHook(...args);
  }

  pushClosedHook(...args: Parameters<NarrativeTurnState["pushClosedHook"]>): ReturnType<NarrativeTurnState["pushClosedHook"]> {
    return this.stateFor(args[0]).pushClosedHook(...args);
  }

  prepareNarrativePersistence(...args: Parameters<NarrativeTurnState["prepareNarrativePersistence"]>): ReturnType<NarrativeTurnState["prepareNarrativePersistence"]> {
    return (this.narrativeStates.get(args[0]) ?? new NarrativeTurnState(args[0]))
      .prepareNarrativePersistence(...args);
  }

  clearTurn(...args: Parameters<NarrativeTurnState["clearTurn"]>): ReturnType<NarrativeTurnState["clearTurn"]> {
    this.narrativeStates.get(args[0])?.clearTurn(...args);
  }

  private ormInstance: BunSQLiteDatabase | null = null;

  private requireOrm(): BunSQLiteDatabase {
    if (!this.db) throw new Error("NarrativeStore detail loading requires the SQLite database");
    return (this.ormInstance ??= drizzle(this.db));
  }

  /**
   * Load a thread's persisted narrative as one chronologically-ordered list.
   *
   * Entries are ordered by `(message.sequence, sortOrder)`. For each assistant
   * message, the final-response narration segment is surfaced as the
   * `assistantMessage` entry (carrying the message body and that segment's
   * sort order) rather than as a separate narration row, so the final response
   * is the message body and never appears as a duplicate preamble. Preamble
   * narration, tool calls, and hooks for the same message interleave by their
   * own sort order. User and system messages are not narrative and are skipped.
   */
  load(threadId: string, range?: TurnRange): NarrativeEntry[] {
    const detailLimit = range?.detail?.limit ?? DEFAULT_DETAIL_LOAD_LIMIT;
    return this.loadDetailWindow(
      threadId,
      range?.limit ?? DEFAULT_LOAD_LIMIT,
      range?.before,
      detailLimit,
      range?.detail?.after,
    );
  }

  private loadDetailWindow(
    threadId: string,
    messageLimit: number,
    before: number | undefined,
    detailLimit: number,
    after: NarrativeDetailCursor | undefined,
  ): NarrativeEntry[] {
    const page = this.loadNarrativeMessages(threadId, messageLimit, before);
    const effectiveDetailLimit = Math.max(1, Math.min(DEFAULT_DETAIL_LOAD_LIMIT * 2, detailLimit));

    const entries: NarrativeEntry[] = [];
    for (const message of page.reverse()) {
      if (message.role !== "assistant" || (after && message.sequence < after.sequence)) continue;
      const messageCursor = after?.sequence === message.sequence ? after : undefined;
      const remaining = effectiveDetailLimit - entries.length;
      if (remaining <= 0) break;

      const messageEntries = this.loadBoundedMessageDetails(message, remaining, messageCursor);
      entries.push(...messageEntries.slice(0, remaining));
      if (entries.length >= effectiveDetailLimit) break;
    }
    return entries;
  }

  private loadNarrativeMessages(
    threadId: string,
    messageLimit: number,
    before: number | undefined,
  ): SelectedNarrativeMessageRow[] {
    const orm = this.requireOrm();
    const pageLimit = Math.max(1, Math.min(DEFAULT_LOAD_LIMIT, messageLimit));
    return orm.select({
      id: messages.id,
      sequence: messages.sequence,
      role: messages.role,
      content: messages.content,
    }).from(messages)
      .where(and(
        eq(messages.threadId, threadId),
        eq(messages.isInternal, 0),
        sql`json_extract(${messages.systemNotice}, '$.scope') IS NOT 'session'`,
        before == null ? undefined : lt(messages.sequence, before),
      ))
      .orderBy(desc(messages.sequence))
      .limit(pageLimit)
      .all();
  }

  /**
   * Reads one assistant message at a time. Each child query seeks from its
   * message-local cursor, so a long turn never requires sorting every detail
   * row before the requested window can be returned.
   */
  private loadBoundedMessageDetails(
    message: SelectedNarrativeMessageRow,
    limit: number,
    after: NarrativeDetailCursor | undefined,
  ): NarrativeEntry[] {
    const orm = this.requireOrm();
    const bodySortOrder = orm.select({ sortOrder: thoughtSegments.sortOrder })
      .from(thoughtSegments)
      .where(and(
        eq(thoughtSegments.messageId, message.id),
        ne(thoughtSegments.isFinalResponse, 0),
      ))
      .orderBy(asc(thoughtSegments.sortOrder), asc(thoughtSegments.id))
      .limit(1)
      .get();
    const body: NarrativeEntry = {
      kind: "assistantMessage",
      messageId: message.id,
      sequence: message.sequence,
      body: message.content,
      sortOrder: bodySortOrder?.sortOrder ?? ASSISTANT_BODY_SORT_ORDER,
    };
    const toolRows = orm.select().from(toolCallRecords)
      .where(and(
        eq(toolCallRecords.messageId, message.id),
        this.detailCursorCondition(after, "toolCall", toolCallRecords.sortOrder, toolCallRecords.id),
      ))
      .orderBy(asc(toolCallRecords.sortOrder), asc(toolCallRecords.id))
      .limit(limit)
      .all();

    const thoughtRows = orm.select().from(thoughtSegments)
      .where(and(
        eq(thoughtSegments.messageId, message.id),
        eq(thoughtSegments.isFinalResponse, 0),
        this.detailCursorCondition(after, "narrationSegment", thoughtSegments.sortOrder, thoughtSegments.id),
      ))
      .orderBy(asc(thoughtSegments.sortOrder), asc(thoughtSegments.id))
      .limit(limit)
      .all();

    const hookRows = orm.select().from(hookExecutions)
      .where(and(
        eq(hookExecutions.messageId, message.id),
        this.detailCursorCondition(after, "hook", hookExecutions.sortOrder, hookExecutions.id),
      ))
      .orderBy(asc(hookExecutions.sortOrder), asc(hookExecutions.id))
      .limit(limit)
      .all();

    const entries = [
      ...(this.isAfterDetailCursor(body, after) ? [body] : []),
      ...toolRows.map((tool) => NarrativeEntrySchema().parse({
        kind: "toolCall",
        sequence: message.sequence,
        sortOrder: tool.sortOrder,
        record: {
          id: tool.id,
          message_id: tool.messageId,
          parent_tool_call_id: tool.parentToolCallId,
          tool_name: tool.toolName,
          display_name: tool.displayName,
          provider_agent_key: tool.providerAgentKey,
          subagent_identity_key: tool.subagentIdentityKey,
          subagent_provider_name: tool.subagentProviderName,
          subagent_prompt: tool.subagentPrompt,
          subagent_type: tool.subagentType,
          subagent_agent_id: tool.subagentAgentId,
          subagent_duration_ms: tool.subagentDurationMs,
          model: tool.model,
          reasoning_effort: tool.reasoningEffort,
          input_summary: tool.inputSummary,
          output_summary: tool.outputSummary,
          output_truncated: tool.outputTruncated,
          output_total_bytes: tool.outputTotalBytes,
          output_artifact_path: tool.outputArtifactPath,
          exit_code: tool.exitCode,
          status: tool.status,
          started_at: tool.startedAt,
          completed_at: tool.completedAt,
          sort_order: tool.sortOrder,
        },
      })),
      ...thoughtRows.map((thought) => NarrativeEntrySchema().parse({
        kind: "narrationSegment",
        sequence: message.sequence,
        sortOrder: thought.sortOrder,
        record: {
          id: thought.id,
          message_id: thought.messageId,
          text: thought.text,
          started_at: thought.startedAt,
          ended_at: thought.endedAt,
          sort_order: thought.sortOrder,
          is_final_response: thought.isFinalResponse,
        },
      })),
      ...hookRows.map((hook) => NarrativeEntrySchema().parse({
        kind: "hook",
        sequence: message.sequence,
        sortOrder: hook.sortOrder,
        record: {
          id: hook.id,
          message_id: hook.messageId,
          hook_name: hook.hookName,
          tool_name: hook.toolName,
          phase: hook.phase,
          payload: hook.payload,
          duration_ms: hook.durationMs,
          did_block: hook.didBlock === 1,
          started_at: hook.startedAt,
          ended_at: hook.endedAt,
          sort_order: hook.sortOrder,
        },
      })),
    ];
    return entries.sort(compareNarrativeEntries);
  }

  private detailCursorCondition(
    after: NarrativeDetailCursor | undefined,
    kind: NarrativeDetailCursor["kind"],
    sortOrder: SQLWrapper,
    id: SQLWrapper,
  ): SQL | undefined {
    if (!after) return undefined;
    const kindOrder = narrativeKindOrder(kind);
    const afterKindOrder = narrativeKindOrder(after.kind);
    if (kindOrder > afterKindOrder) return gte(sortOrder, after.sortOrder);
    if (kindOrder < afterKindOrder) return gt(sortOrder, after.sortOrder);
    return sql`(${sortOrder}, ${id}) > (${after.sortOrder}, ${after.id})`;
  }

  private isAfterDetailCursor(entry: NarrativeEntry, after: NarrativeDetailCursor | undefined): boolean {
    if (!after) return true;
    return this.compareDetailPosition(
      entry.sequence,
      entry.sortOrder,
      entry.kind,
      narrativeEntryId(entry),
      after.sequence,
      after.sortOrder,
      after.kind,
      after.id,
    ) > 0;
  }

  private compareDetailPosition(
    leftSequence: number,
    leftSortOrder: number,
    leftKind: NarrativeDetailCursor["kind"],
    leftId: string,
    rightSequence: number,
    rightSortOrder: number,
    rightKind: NarrativeDetailCursor["kind"],
    rightId: string,
  ): number {
    return leftSequence - rightSequence
      || leftSortOrder - rightSortOrder
      || narrativeKindOrder(leftKind) - narrativeKindOrder(rightKind)
      || compareSqliteBinaryIds(leftId, rightId);
  }

  /** Read accepted history before its owner reserves only the unsaved changed records. */
  terminalSnapshot(...args: Parameters<NarrativeTurnState["terminalSnapshot"]>): ReturnType<NarrativeTurnState["terminalSnapshot"]> {
    return this.narrativeStates.get(args[0])?.terminalSnapshot(...args) ?? [];
  }
  /** Build persisted narrative entries for an already-loaded message page. */
  loadForMessages(messages: readonly Message[]): NarrativeEntry[] {
    return new NarrativeReadStore(this.toolCallRecordRepo, this.thoughtSegmentRepo, this.hookExecutionRepo).loadForMessages(messages);
  }
  /** Persist recovered rows through acknowledged owner commands. */
  async persistRecoveredNarrative(messageId: string, items: readonly ParentNarrativeRecoveryItem[], replaceExisting = false): Promise<void> {
    await this.messageRepo.persistRecoveredNarrative(messageId, items, replaceExisting);
  }

  /**
   * Persist the buffered narrative rows (tool calls, thoughts, hooks) for a
   * completed turn against `messageId`, tagging the final-response thought via
   * the `is_final_response` suffix-match safety net. Drains the in-flight
   * thought and any open hooks first so a turn that ends without a trailing
   * tool call still records its tail. Returns the tool-call count for the
   * `turn.persisted` broadcast that AgentService still owns.
   *
   * The volatile buffers are NOT cleared here (Trap 3) — call {@link clearTurn}
   * after the turn-level persistence (snapshots, broadcast) completes.
   */
  async persistNarrative(
    threadId: string,
    messageId: string,
    messageContent: string,
    outcome: TurnOutcome,
    options: { strict?: boolean } = {},
  ): Promise<PersistNarrativeResult> {
    const prepared = this.prepareNarrativePersistence(
      threadId,
      messageId,
      messageContent,
      outcome,
    );
    await this.persistNarrativeRows(prepared.toolCalls, options.strict, threadId, "tool call records", (items) => this.toolCallRecordRepo.bulkCreate(items));
    await this.persistNarrativeRows(prepared.thoughts, options.strict, threadId, "thought segments", (items) => this.thoughtSegmentRepo.bulkCreate(items));
    await this.persistNarrativeRows(prepared.hooks, options.strict, threadId, "hook executions", (items) => this.hookExecutionRepo.bulkCreate(items));
    return { toolCallCount: prepared.toolCalls.length };
  }

  private async persistNarrativeRows<T>(
    items: T[],
    strict: boolean | undefined,
    threadId: string,
    rowDescription: string,
    persist: (items: T[]) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    try {
      await persist(items);
    } catch (err) {
      if (strict) throw err;
      logger.error(`Failed to persist ${rowDescription}`, {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Persist one active turn through bounded transactions that yield between commits. */
  async persistNarrativeBatched(
    threadId: string,
    messageId: string,
    messageContent: string,
    outcome: TurnOutcome,
    options: { strict?: boolean; replaceExisting?: boolean } = {},
  ): Promise<PersistNarrativeResult> {
    const persisted: PersistedNarrativeRows = {
      toolCalls: new Set<string>(),
      thoughts: new Set<string>(),
      hooks: new Set<string>(),
    };

    for (let pass = 0; pass < 16; pass += 1) {
      const prepared = this.prepareNarrativePersistence(
        threadId,
        messageId,
        messageContent,
        outcome,
      );
      const pending = this.pendingNarrativeRows(prepared, persisted);
      if (this.narrativeRowsAreEmpty(pending)) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const afterYield = this.prepareNarrativePersistence(
          threadId,
          messageId,
          messageContent,
          outcome,
        );
        if (this.narrativeRowsAreEmpty(this.pendingNarrativeRows(afterYield, persisted))) {
          return { toolCallCount: persisted.toolCalls.size };
        }
        continue;
      }
      await this.persistBatchedNarrativeRows(
        pending.toolCalls, persisted.toolCalls, (item) => item.toolCallId!,
        (items) => this.toolCallRecordRepo.bulkCreateBatched(
          items, ACTIVE_TURN_WRITE_BATCH_LIMITS, options.replaceExisting,
        ), options.strict, threadId, "tool call records",
      );
      await this.persistBatchedNarrativeRows(
        pending.thoughts, persisted.thoughts, (item) => item.id!,
        (items) => this.thoughtSegmentRepo.bulkCreateBatched(
          items, ACTIVE_TURN_WRITE_BATCH_LIMITS, options.replaceExisting,
        ), options.strict, threadId, "thought segments",
      );
      await this.persistBatchedNarrativeRows(
        pending.hooks, persisted.hooks, (item) => item.id!,
        (items) => this.hookExecutionRepo.bulkCreateBatched(
          items, ACTIVE_TURN_WRITE_BATCH_LIMITS, options.replaceExisting,
        ), options.strict, threadId, "hook executions",
      );
    }

    throw new Error(`Narrative persistence did not quiesce for ${threadId}`);
  }

  private pendingNarrativeRows(
    prepared: PreparedNarrativePersistence,
    persisted: PersistedNarrativeRows,
  ): PendingNarrativePersistence {
    return {
      toolCalls: prepared.toolCalls.filter((item) => !persisted.toolCalls.has(item.toolCallId!)),
      thoughts: prepared.thoughts.filter((item) => !persisted.thoughts.has(item.id!)),
      hooks: prepared.hooks.filter((item) => !persisted.hooks.has(item.id!)),
    };
  }

  private narrativeRowsAreEmpty(rows: PendingNarrativePersistence): boolean {
    return rows.toolCalls.length === 0 && rows.thoughts.length === 0 && rows.hooks.length === 0;
  }

  private async persistBatchedNarrativeRows<T>(
    items: T[],
    persisted: Set<string>,
    identifier: (item: T) => string,
    persist: (items: T[]) => Promise<unknown>,
    strict: boolean | undefined,
    threadId: string,
    rowDescription: string,
  ): Promise<void> {
    if (items.length === 0) return;
    try {
      await persist(items);
    } catch (err) {
      if (strict) throw err;
      this.recordPersistedNarrativeRows(items, persisted, identifier);
      logger.error(`Failed to persist ${rowDescription}`, {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.recordPersistedNarrativeRows(items, persisted, identifier);
  }

  private recordPersistedNarrativeRows<T>(
    items: readonly T[],
    persisted: Set<string>,
    identifier: (item: T) => string,
  ): void {
    for (const item of items) persisted.add(identifier(item));
  }
}
