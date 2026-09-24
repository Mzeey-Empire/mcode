import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, gt, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  CONVERSATION_HISTORY_PAGE_MAX_MESSAGES,
  ThoughtSegmentRecordSchema,
  ToolCallRecordSchema,
  type ConversationNarrativeBatch,
  type Message,
} from "@mcode/contracts";
import {
  canonicalAgentIngestCheckpoints,
  canonicalAgentItems,
} from "../../../runtime/persistence/sqlite/schema.js";

/** Canonical conversation rows used by the staged compatibility read. */
export interface CanonicalConversationProjection {
  messages: Message[];
  narrativeByMessage: Record<string, ConversationNarrativeBatch>;
  hasMore: boolean;
}

interface MessageProjectionRow {
  turnId: string;
  message: Message;
}

interface NarrativeRow {
  id: string;
  kind: string;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
  turnId: string;
}

interface NarrativePayload {
  projection?: string;
  record?: Record<string, unknown>;
  nativeItemId?: string;
  toolName?: string;
  toolInput?: unknown;
  output?: string;
  isError?: boolean;
  content?: string;
}

interface ProjectionState {
  narrativeByMessage: Record<string, ConversationNarrativeBatch>;
  childToolsByMessage: Map<string, Map<string, ConversationNarrativeBatch["tools"][number]>>;
  childThoughtOrderByMessage: Map<string, number>;
}

/** Reads canonical conversation rows and projects narrative records for compatibility consumers. */
export class CanonicalConversationProjectionReader {
  private readonly orm: BunSQLiteDatabase;

  constructor(db: Database) {
    this.orm = drizzle(db);
  }

  /** Loads one canonical conversation page in ascending message order. */
  load(
    threadId: string,
    limit: number,
    before?: number,
    after?: number,
  ): CanonicalConversationProjection {
    const page = this.loadMessagePage(threadId, limit, before, after);
    const messages = page.rows.map(({ message }) => message);
    const narrativeByMessage = this.createNarrativeBuckets(messages);
    if (messages.length === 0) return { messages, narrativeByMessage, hasMore: page.hasMore };

    const narrativeRows = this.loadNarrativeRows(threadId, page.rows);
    const childTurnIds = this.findChildTurnIds(narrativeRows);
    const childRows = this.loadChildMessageRows(threadId, childTurnIds);
    const childMessageByTurn = this.selectChildAnchorByTurn(page.rows, childRows);
    const state: ProjectionState = {
      narrativeByMessage,
      childToolsByMessage: new Map(),
      childThoughtOrderByMessage: new Map(),
    };
    this.projectNarrativeRows(narrativeRows, childMessageByTurn, state);
    this.appendChildTools(state);
    return { messages, narrativeByMessage, hasMore: page.hasMore };
  }

  private loadMessagePage(
    threadId: string,
    limit: number,
    before?: number,
    after?: number,
  ): { rows: MessageProjectionRow[]; hasMore: boolean } {
    const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const cursor = after ?? before ?? Number.MAX_SAFE_INTEGER;
    const messageSequence = sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.sequence')`;
    const messageId = sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.id')`;
    const rows = this.orm
      .select({
        turnId: canonicalAgentItems.turnId,
        payloadJson: canonicalAgentItems.payloadJson,
      })
      .from(canonicalAgentItems)
      .where(and(
        ...messageProjectionConditions(threadId),
        after === undefined ? lt(messageSequence, cursor) : gt(messageSequence, cursor),
      ))
      .orderBy(
        ...(after === undefined
          ? [desc(messageSequence), desc(messageId)]
          : [asc(messageSequence), asc(messageId)]),
      )
      .limit(clampedLimit + 1)
      .all();
    const hasMore = rows.length > clampedLimit;
    const pageRows = rows.slice(0, clampedLimit).map(toMessageProjectionRow);
    pageRows.sort(compareMessageProjectionRows);
    return { rows: pageRows, hasMore };
  }

  private createNarrativeBuckets(messages: readonly Message[]): Record<string, ConversationNarrativeBatch> {
    const narrativeByMessage: Record<string, ConversationNarrativeBatch> = {};
    for (const message of messages) {
      narrativeByMessage[message.id] = { tools: [], thoughts: [], hooks: [] };
    }
    return narrativeByMessage;
  }

  private loadNarrativeRows(threadId: string, messageRows: readonly MessageProjectionRow[]): NarrativeRow[] {
    const turnIds = [...new Set(messageRows.map(({ turnId }) => turnId))];
    return this.orm
      .select({
        id: canonicalAgentItems.id,
        kind: canonicalAgentItems.kind,
        payloadJson: canonicalAgentItems.payloadJson,
        createdAt: canonicalAgentItems.createdAt,
        updatedAt: canonicalAgentItems.updatedAt,
        turnId: canonicalAgentItems.turnId,
      })
      .from(canonicalAgentItems)
      .where(and(
        eq(canonicalAgentItems.threadId, threadId),
        ne(canonicalAgentItems.kind, "message"),
        inArray(canonicalAgentItems.turnId, turnIds),
      ))
      .orderBy(asc(canonicalAgentItems.createdAt), asc(canonicalAgentItems.id))
      .limit(CONVERSATION_HISTORY_PAGE_MAX_MESSAGES)
      .all();
  }

  private findChildTurnIds(rows: readonly NarrativeRow[]): string[] {
    const childTurnIds = new Set<string>();
    for (const row of rows) {
      if (isCodexChildProjection(parseNarrativePayload(row))) childTurnIds.add(row.turnId);
    }
    return [...childTurnIds];
  }

  private loadChildMessageRows(threadId: string, childTurnIds: readonly string[]): MessageProjectionRow[] {
    if (childTurnIds.length === 0) return [];
    const candidateMessages = this.orm.$with("candidate_messages").as(
      this.orm
        .select({
          turnId: canonicalAgentItems.turnId,
          payloadJson: canonicalAgentItems.payloadJson,
          candidateRank: sql<number>`ROW_NUMBER() OVER (
            PARTITION BY ${canonicalAgentItems.turnId}
            ORDER BY CASE
              WHEN json_extract(${canonicalAgentItems.payloadJson}, '$.message.role') = 'assistant' THEN 0
              ELSE 1
            END,
            json_extract(${canonicalAgentItems.payloadJson}, '$.message.sequence') ASC,
            json_extract(${canonicalAgentItems.payloadJson}, '$.message.id') ASC
          )`.as("candidate_rank"),
        })
        .from(canonicalAgentItems)
        .where(and(
          ...messageProjectionConditions(threadId),
          inArray(canonicalAgentItems.turnId, childTurnIds),
        )),
    );
    const rows = this.orm
      .with(candidateMessages)
      .select({
        turnId: candidateMessages.turnId,
        payloadJson: candidateMessages.payloadJson,
      })
      .from(candidateMessages)
      .where(lte(candidateMessages.candidateRank, 2))
      .orderBy(asc(candidateMessages.turnId), asc(candidateMessages.candidateRank))
      .limit(childTurnIds.length * 2)
      .all();
    return rows.map(toMessageProjectionRow);
  }

  private selectChildAnchorByTurn(
    pageRows: readonly MessageProjectionRow[],
    childRows: readonly MessageProjectionRow[],
  ): Map<string, string> {
    const messagesById = new Map<string, Message>();
    const childMessageByTurn = new Map<string, string>();
    for (const row of [...pageRows, ...childRows]) messagesById.set(row.message.id, row.message);
    for (const row of [...pageRows, ...childRows]) {
      const current = childMessageByTurn.get(row.turnId);
      if (!current || (row.message.role === "assistant" && messagesById.get(current)?.role !== "assistant")) {
        childMessageByTurn.set(row.turnId, row.message.id);
      }
    }
    return childMessageByTurn;
  }

  private projectNarrativeRows(
    rows: readonly NarrativeRow[],
    childMessageByTurn: ReadonlyMap<string, string>,
    state: ProjectionState,
  ): void {
    for (const row of rows) {
      const payload = parseNarrativePayload(row);
      if (this.projectCodexChildRow(row, payload, childMessageByTurn, state)) continue;
      this.projectOrdinaryNarrative(payload, state.narrativeByMessage);
    }
  }

  private projectCodexChildRow(
    row: NarrativeRow,
    payload: NarrativePayload,
    childMessageByTurn: ReadonlyMap<string, string>,
    state: ProjectionState,
  ): boolean {
    const childAnchor = childMessageByTurn.get(row.turnId);
    if (!childAnchor || !state.narrativeByMessage[childAnchor] || !isCodexChildProjection(payload)) return false;
    switch (payload.projection) {
      case "codexChildReasoning":
        this.projectChildReasoning(row, payload, childAnchor, state);
        break;
      case "codexChildToolCall":
        this.projectChildToolCall(row, payload, childAnchor, state);
        break;
      case "codexChildToolResult":
        this.projectChildToolResult(row, payload, childAnchor, state);
        break;
    }
    return true;
  }

  private projectChildReasoning(
    row: NarrativeRow,
    payload: NarrativePayload,
    childAnchor: string,
    state: ProjectionState,
  ): void {
    const nativeItemId = payload.nativeItemId ?? row.payloadJson;
    const sortOrder = state.childThoughtOrderByMessage.get(childAnchor) ?? 0;
    state.narrativeByMessage[childAnchor]!.thoughts.push(ThoughtSegmentRecordSchema().parse({
      id: `codex-child-reasoning:${hashCodexKey(`${nativeItemId}:${row.id}`)}`,
      message_id: childAnchor,
      text: typeof payload.content === "string" ? payload.content : "",
      started_at: row.createdAt,
      ended_at: row.updatedAt,
      sort_order: sortOrder,
    }));
    state.childThoughtOrderByMessage.set(childAnchor, sortOrder + 1);
  }

  private projectChildToolCall(
    row: NarrativeRow,
    payload: NarrativePayload,
    childAnchor: string,
    state: ProjectionState,
  ): void {
    const nativeItemId = this.childToolNativeItemId(row, payload);
    const childTools = this.childToolsForMessage(childAnchor, state);
    const existing = childTools.get(nativeItemId);
    childTools.set(nativeItemId, this.childToolCallRecord(
      row,
      payload,
      childAnchor,
      nativeItemId,
      existing,
      childTools.size,
    ));
  }

  private projectChildToolResult(
    row: NarrativeRow,
    payload: NarrativePayload,
    childAnchor: string,
    state: ProjectionState,
  ): void {
    const nativeItemId = this.childToolNativeItemId(row, payload);
    const childTools = this.childToolsForMessage(childAnchor, state);
    const existing = childTools.get(nativeItemId);
    childTools.set(nativeItemId, this.childToolResultRecord(
      row,
      payload,
      childAnchor,
      nativeItemId,
      existing,
      childTools.size,
    ));
  }

  private childToolNativeItemId(row: NarrativeRow, payload: NarrativePayload): string {
    return payload.nativeItemId ?? row.payloadJson;
  }

  private childToolsForMessage(
    childAnchor: string,
    state: ProjectionState,
  ): Map<string, ConversationNarrativeBatch["tools"][number]> {
    const existing = state.childToolsByMessage.get(childAnchor);
    if (existing) return existing;
    const created = new Map<string, ConversationNarrativeBatch["tools"][number]>();
    state.childToolsByMessage.set(childAnchor, created);
    return created;
  }

  private childToolCallRecord(
    row: NarrativeRow,
    payload: NarrativePayload,
    childAnchor: string,
    nativeItemId: string,
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    sortOrder: number,
  ): ConversationNarrativeBatch["tools"][number] {
    return ToolCallRecordSchema().parse({
      ...this.childToolBase(existing, nativeItemId, childAnchor),
      ...this.childToolCallDetails(row, payload, existing, sortOrder),
    });
  }

  private childToolResultRecord(
    row: NarrativeRow,
    payload: NarrativePayload,
    childAnchor: string,
    nativeItemId: string,
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    sortOrder: number,
  ): ConversationNarrativeBatch["tools"][number] {
    return ToolCallRecordSchema().parse({
      ...this.childToolBase(existing, nativeItemId, childAnchor),
      ...this.childToolResultDetails(row, payload, existing, sortOrder),
    });
  }

  private childToolBase(
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    nativeItemId: string,
    childAnchor: string,
  ) {
    return {
      id: this.childToolId(existing, nativeItemId),
      message_id: childAnchor,
      parent_tool_call_id: null,
    };
  }

  private childToolCallDetails(
    row: NarrativeRow,
    payload: NarrativePayload,
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    sortOrder: number,
  ) {
    return {
      tool_name: typeof payload.toolName === "string" ? payload.toolName : "Tool",
      input_summary: formatToolInput(payload.toolInput),
      ...this.runningChildToolDetails(row, existing, sortOrder),
    };
  }

  private runningChildToolDetails(
    row: NarrativeRow,
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    sortOrder: number,
  ) {
    return {
      output_summary: this.childToolOutput(existing),
      status: this.runningChildToolStatus(existing),
      ...this.runningChildToolTiming(row, existing, sortOrder),
    };
  }

  private childToolOutput(existing: ConversationNarrativeBatch["tools"][number] | undefined): string {
    return existing?.output_summary ?? "";
  }

  private runningChildToolStatus(
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
  ) {
    return existing?.status ?? "running";
  }

  private runningChildToolTiming(
    row: NarrativeRow,
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    sortOrder: number,
  ) {
    return {
      started_at: existing?.started_at ?? row.createdAt,
      completed_at: existing?.completed_at ?? null,
      sort_order: existing?.sort_order ?? sortOrder,
    };
  }

  private childToolResultDetails(
    row: NarrativeRow,
    payload: NarrativePayload,
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    sortOrder: number,
  ) {
    return {
      tool_name: existing?.tool_name ?? "Tool",
      input_summary: existing?.input_summary ?? "",
      output_summary: typeof payload.output === "string" ? payload.output : "",
      status: payload.isError === true ? "failed" : "completed",
      ...this.completedChildToolDetails(row, existing, sortOrder),
    };
  }

  private completedChildToolDetails(
    row: NarrativeRow,
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    sortOrder: number,
  ) {
    return {
      started_at: existing?.started_at ?? row.createdAt,
      completed_at: row.updatedAt,
      sort_order: existing?.sort_order ?? sortOrder,
    };
  }

  private childToolId(
    existing: ConversationNarrativeBatch["tools"][number] | undefined,
    nativeItemId: string,
  ): string {
    return existing?.id ?? `codex-child-tool:${hashCodexKey(nativeItemId)}`;
  }

  private projectOrdinaryNarrative(
    payload: NarrativePayload,
    narrativeByMessage: Record<string, ConversationNarrativeBatch>,
  ): void {
    const record = payload.record;
    if (!record || typeof record.message_id !== "string") return;
    const bucket = narrativeByMessage[record.message_id];
    if (!bucket) return;
    switch (payload.projection) {
      case "toolCall":
        bucket.tools.push(record as unknown as ConversationNarrativeBatch["tools"][number]);
        break;
      case "narrationSegment":
        bucket.thoughts.push(record as unknown as ConversationNarrativeBatch["thoughts"][number]);
        break;
      case "hook":
        bucket.hooks.push(record as unknown as ConversationNarrativeBatch["hooks"][number]);
        break;
    }
  }

  private appendChildTools(state: ProjectionState): void {
    for (const [messageId, childTools] of state.childToolsByMessage) {
      state.narrativeByMessage[messageId]!.tools.push(...childTools.values());
    }
  }
}

function toMessageProjectionRow(row: { turnId: string; payloadJson: string }): MessageProjectionRow {
  return { turnId: row.turnId, message: (JSON.parse(row.payloadJson) as { message: Message }).message };
}

function compareMessageProjectionRows(left: MessageProjectionRow, right: MessageProjectionRow): number {
  return left.message.sequence - right.message.sequence || left.message.id.localeCompare(right.message.id);
}

function parseNarrativePayload(row: Pick<NarrativeRow, "payloadJson">): NarrativePayload {
  return JSON.parse(row.payloadJson) as NarrativePayload;
}

function isCodexChildProjection(payload: NarrativePayload): boolean {
  return payload.projection === "codexChildReasoning"
    || payload.projection === "codexChildToolCall"
    || payload.projection === "codexChildToolResult";
}

function formatToolInput(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function hashCodexKey(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

// Both message-page reads share this predicate block; one definition keeps the
// projection gate from drifting between the page query and the child CTE.
function messageProjectionConditions(threadId: string) {
  return [
    eq(canonicalAgentItems.threadId, threadId),
    eq(canonicalAgentItems.kind, "message"),
    eq(sql`json_extract(${canonicalAgentItems.payloadJson}, '$.projection')`, "message"),
    eq(sql`COALESCE(json_extract(${canonicalAgentItems.payloadJson}, '$.message.is_internal'), 0)`, 0),
    or(
      ne(sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.role')`, "assistant"),
      sql`EXISTS (
        SELECT 1
        FROM ${canonicalAgentIngestCheckpoints} checkpoint
        WHERE checkpoint.turn_id = ${canonicalAgentItems.turnId}
          AND checkpoint.terminal_outcome IS NOT NULL
      )`,
    ),
  ];
}
