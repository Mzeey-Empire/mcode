/**
 * Message data access layer.
 * Provides creation and retrieval operations for message records in SQLite.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Changes, Database } from "bun:sqlite";
import { and, asc, count, desc, eq, getTableColumns, gt, inArray, isNotNull, lt, lte, placeholder, sql, type SQL } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  Message,
  LegacyMessageProvenance,
  MessageMention,
  MessageRole,
  ParentAgentMessageProvenance,
  PreviewAnnotationBundle,
  SelectedTextComment,
  StoredAttachment,
  SystemNoticeMetadata,
  TurnOutcome,
} from "@mcode/contracts";
import {
  PreviewAnnotationBundleSchema,
  LegacyMessageProvenanceSchema,
  ParentAgentMessageProvenanceSchema,
  SelectedTextCommentsSchema,
  SystemNoticeMetadataSchema,
  THREAD_GET_TRANSCRIPT_MAX_BYTES,
} from "@mcode/contracts";
import { messages, threads, toolCallRecords } from "../../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";

type MessageRow = typeof messages.$inferSelect & { toolCallCount?: number };

type MessageOriginInput =
  | { type: "composer" }
  | {
      type: "thread";
      sourceThreadId: string;
      sourceTurnId: string;
      sourceProviderId: string;
    };

/** Persisted fields needed to build the bounded thread-control transcript. */
export interface ThreadControlMessageRecord {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  provider: string | null;
  model: string | null;
  originType: "composer" | "thread" | "legacy";
  sourceThreadId: string | null;
  sourceTurnId: string | null;
  sourceProviderId: string | null;
}

export interface ThreadHistoryBudget {
  budgetBytes: number;
  retainedBytes: number;
  omittedBeforeCount: number;
  truncatedMessages: Array<{
    id: string;
    originalBytes: number;
    retainedBytes: number;
  }>;
}

export interface BudgetedThreadMessages {
  messages: Message[];
  budget: ThreadHistoryBudget;
}

export interface BudgetedThreadMessageOptions {
  maxBytes: number;
  pageSize?: number;
  maxRows?: number;
  includeInternal?: boolean;
}

function parseJsonField(value: string | null): unknown | null {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parsePreviewAnnotations(value: string | null): PreviewAnnotationBundle | null {
  const parsed = parseJsonField(value);
  if (parsed === null) return null;
  return PreviewAnnotationBundleSchema().parse(parsed);
}

function serializePreviewAnnotations(
  previewAnnotations: PreviewAnnotationBundle | undefined,
): string | null {
  if (!previewAnnotations) return null;
  return JSON.stringify(PreviewAnnotationBundleSchema().parse(previewAnnotations));
}

function parseSelectedTextComments(value: string | null): SelectedTextComment[] | null {
  const parsed = parseJsonField(value);
  if (parsed === null) return null;
  return SelectedTextCommentsSchema().parse(parsed);
}

function parseSystemNotice(value: string | null): SystemNoticeMetadata | null {
  const parsed = parseJsonField(value);
  if (parsed === null) return null;
  return SystemNoticeMetadataSchema().parse(parsed);
}

function parseParentAgentProvenance(value: string): ParentAgentMessageProvenance {
  return ParentAgentMessageProvenanceSchema().parse(JSON.parse(value) as unknown);
}

function parseLegacyProvenance(value: string): LegacyMessageProvenance {
  return LegacyMessageProvenanceSchema().parse(JSON.parse(value) as unknown);
}

function serializeSelectedTextComments(
  selectedTextComments: SelectedTextComment[] | undefined,
): string | null {
  if (!selectedTextComments || selectedTextComments.length === 0) return null;
  return JSON.stringify(SelectedTextCommentsSchema().parse(selectedTextComments));
}

function rowToMessage(row: MessageRow): Message {
  const msg: Message = {
    id: row.id,
    thread_id: row.threadId,
    role: row.role as MessageRole,
    content: row.content,
    tool_calls: parseJsonField(row.toolCalls),
    files_changed: parseJsonField(row.filesChanged),
    cost_usd: row.costUsd,
    tokens_used: row.tokensUsed,
    timestamp: row.timestamp,
    sequence: row.sequence,
    attachments: parseJsonField(row.attachments) as
      | StoredAttachment[]
      | null,
    previewAnnotations: parsePreviewAnnotations(row.previewAnnotations),
    mentions: parseJsonField(row.mentions) as MessageMention[] | null,
    selectedTextComments: parseSelectedTextComments(row.selectedTextComments),
    reply_to_message_id: row.replyToMessageId,
    quoted_text: row.quotedText,
    model: row.model,
    outcome: (row.outcome ?? null) as TurnOutcome | null,
    outcomeExecutionId: row.outcomeExecutionId ?? null,
    systemNotice: parseSystemNotice(row.systemNotice),
    is_internal: row.isInternal === 1,
    ...(row.parentAgentProvenance
      ? { parentAgentProvenance: parseParentAgentProvenance(row.parentAgentProvenance) }
      : {}),
    ...(row.legacyProvenance
      ? { legacyProvenance: parseLegacyProvenance(row.legacyProvenance) }
      : row.originType === "legacy"
      ? {
          legacyProvenance: {
            source: "messages" as const,
            migrationVersion: null,
            mapping: "legacy" as const,
            reason: "The legacy structure does not prove a canonical turn mapping.",
          },
        }
      : {}),
  };

  if (row.toolCallCount && row.toolCallCount > 0) {
    msg.tool_call_count = row.toolCallCount;
  }

  return msg;
}

/** Session-scoped system notices are hidden from transcript reads. */
const notSessionNotice = sql`json_extract(${messages.systemNotice}, '$.scope') IS NOT 'session'`;

const DEFAULT_HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGE_SIZE = 500;
const DEFAULT_HISTORY_MAX_ROWS = 500;
const MAX_HISTORY_MAX_ROWS = 2_000;

function clampPositiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function takeUtf8Prefix(text: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 };
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const next = byteLength(char);
    if (bytes + next > maxBytes) break;
    out += char;
    bytes += next;
  }
  return { text: out, bytes };
}

/** Repository for message creation and retrieval against SQLite. */
@injectable()
export class MessageRepo {
  private readonly orm: BunSQLiteDatabase;
  private createStatement: ReturnType<MessageRepo["buildCreateStatement"]> | null = null;
  private createAssistantStatement: ReturnType<MessageRepo["buildCreateAssistantStatement"]> | null = null;
  private publishAssistantStatement: ReturnType<MessageRepo["buildPublishAssistantStatement"]> | null = null;
  private latestSequenceStatement: ReturnType<MessageRepo["buildLatestSequenceStatement"]> | null = null;

  constructor(@inject("Database") private readonly db: Database) {
    this.orm = drizzle(db);
  }

  private buildCreateStatement() {
    return this.orm.insert(messages).values({
      id: placeholder("id"),
      threadId: placeholder("threadId"),
      role: placeholder("role"),
      content: placeholder("content"),
      timestamp: placeholder("timestamp"),
      sequence: placeholder("sequence"),
      attachments: placeholder("attachments"),
      previewAnnotations: placeholder("previewAnnotations"),
      mentions: placeholder("mentions"),
      replyToMessageId: placeholder("replyToMessageId"),
      quotedText: placeholder("quotedText"),
      model: placeholder("model"),
      originType: placeholder("originType"),
      sourceThreadId: placeholder("sourceThreadId"),
      sourceTurnId: placeholder("sourceTurnId"),
      sourceProviderId: placeholder("sourceProviderId"),
      isInternal: placeholder("isInternal"),
      selectedTextComments: placeholder("selectedTextComments"),
      systemNotice: placeholder("systemNotice"),
    }).prepare();
  }

  private getCreateStatement() {
    return this.createStatement ??= this.buildCreateStatement();
  }

  private buildCreateAssistantStatement() {
    return this.orm.insert(messages).values({
      id: placeholder("id"),
      threadId: placeholder("threadId"),
      role: "assistant",
      content: placeholder("content"),
      timestamp: placeholder("timestamp"),
      sequence: placeholder("sequence"),
      attachments: placeholder("attachments"),
      mentions: placeholder("mentions"),
      model: placeholder("model"),
      provider: placeholder("provider"),
      originType: "composer",
      isInternal: placeholder("isInternal"),
    }).onConflictDoNothing().prepare();
  }

  private getCreateAssistantStatement() {
    return this.createAssistantStatement ??= this.buildCreateAssistantStatement();
  }

  private buildPublishAssistantStatement() {
    return this.orm.update(messages)
      .set({ isInternal: 0 })
      .where(and(eq(messages.id, placeholder("id")), eq(messages.role, "assistant")))
      .prepare();
  }

  private getPublishAssistantStatement() {
    return this.publishAssistantStatement ??= this.buildPublishAssistantStatement();
  }

  private buildLatestSequenceStatement() {
    return this.orm.select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.threadId, placeholder("threadId")))
      .orderBy(desc(messages.sequence))
      .limit(1)
      .prepare();
  }

  private getLatestSequenceStatement() {
    return this.latestSequenceStatement ??= this.buildLatestSequenceStatement();
  }

  /**
   * Create a new message and return the fully-populated record.
   *
   * `model` records the model identifier active when an assistant message was
   * produced (e.g. "claude-opus-4-7"). Null for user/system messages and
   * acceptable for assistant messages when the provider doesn't surface a
   * model — the UI footer falls back gracefully.
   * `messageId` preserves the renderer's optimistic identity when supplied.
   */
  create(
    threadId: string,
    role: MessageRole,
    content: string,
    sequence: number,
    attachments?: StoredAttachment[],
    replyToMessageId?: string,
    quotedText?: string,
    model?: string | null,
    isInternal?: boolean,
    mentions?: MessageMention[],
    previewAnnotations?: PreviewAnnotationBundle,
    origin: MessageOriginInput = { type: "composer" },
    messageId?: string,
    selectedTextComments?: SelectedTextComment[],
    systemNotice?: SystemNoticeMetadata,
  ): Message {
    const id = messageId ?? NodeCrypto.randomUUID();
    const now = new Date().toISOString();
    const attachmentsJson = this.serializeNonEmptyArray(attachments);
    const mentionsJson = this.serializeNonEmptyArray(mentions);
    const previewAnnotationsJson = serializePreviewAnnotations(previewAnnotations);
    const selectedTextCommentsJson = serializeSelectedTextComments(selectedTextComments);
    const systemNoticeJson = systemNotice ? JSON.stringify(SystemNoticeMetadataSchema().parse(systemNotice)) : null;
    const modelValue = model ?? null;
    const source = this.messageSource(origin);

    this.getCreateStatement().run({
      id,
      threadId,
      role,
      content,
      timestamp: now,
      sequence,
      attachments: attachmentsJson,
      previewAnnotations: previewAnnotationsJson,
      mentions: mentionsJson,
      replyToMessageId: replyToMessageId ?? null,
      quotedText: quotedText ?? null,
      model: modelValue,
      originType: origin.type,
      sourceThreadId: source.threadId,
      sourceTurnId: source.turnId,
      sourceProviderId: source.providerId,
      isInternal: isInternal ? 1 : 0,
      selectedTextComments: selectedTextCommentsJson,
      systemNotice: systemNoticeJson,
    });

    return this.createdMessage({
      id,
      threadId,
      role,
      content,
      sequence,
      timestamp: now,
      attachments,
      previewAnnotations,
      mentions,
      selectedTextComments,
      replyToMessageId,
      quotedText,
      model: modelValue,
      isInternal,
      systemNotice,
    });
  }

  /** Create a visible system message carrying bounded provider notice metadata. */
  createSystemNotice(
    threadId: string,
    content: string,
    sequence: number,
    systemNotice: SystemNoticeMetadata | undefined,
  ): Message {
    const metadata = systemNotice ? SystemNoticeMetadataSchema().parse(systemNotice) : undefined;
    return this.db.transaction(() => this.writeSystemNotice(threadId, content, sequence, metadata))();
  }

  private writeSystemNotice(threadId: string, content: string, sequence: number, systemNotice: SystemNoticeMetadata | undefined): Message {
    if (systemNotice?.noticeKey) {
      const existing = this.orm.select().from(messages).where(and(
        eq(messages.threadId, threadId),
        sql`json_extract(${messages.systemNotice}, '$.sessionId') IS ${systemNotice.sessionId ?? null}`,
        sql`(json_extract(${messages.systemNotice}, '$.noticeKey') = ${systemNotice.noticeKey} OR (${systemNotice.kind} = 'model-rerouted' AND json_extract(${messages.systemNotice}, '$.kind') = 'model-rerouted'))`,
      )).orderBy(desc(messages.sequence)).limit(1).get();
      if (existing) {
        this.orm.update(messages)
          .set({ content, systemNotice: JSON.stringify(systemNotice) })
          .where(eq(messages.id, existing.id))
          .run();
        return rowToMessage({ ...existing, content, systemNotice: JSON.stringify(systemNotice) });
      }
    }
    if (systemNotice?.scope === "session") {
      // drizzle drops limit(-1), emitting a bare OFFSET which is invalid
      // SQLite; a saturating limit keeps the "all but the newest 19" semantics.
      const prunableIds = this.orm.select({ id: messages.id }).from(messages).where(and(
        eq(messages.threadId, threadId),
        sql`json_extract(${messages.systemNotice}, '$.scope') = 'session'`,
        sql`json_extract(${messages.systemNotice}, '$.sessionId') IS ${systemNotice.sessionId ?? null}`,
      )).orderBy(desc(messages.sequence)).limit(Number.MAX_SAFE_INTEGER).offset(19);
      this.orm.delete(messages).where(inArray(messages.id, prunableIds)).run();
    }
    return this.create(
      threadId, "system", content, sequence,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, systemNotice,
    );
  }

  /** Select the provider notice session and expire session-scoped rows from prior sessions. */
  beginNoticeSession(threadId: string, sessionId: string | undefined): void {
    this.db.transaction(() => {
      this.orm.update(threads)
        .set({ currentNoticeSessionId: sessionId ?? null })
        .where(eq(threads.id, threadId))
        .run();
      this.orm.delete(messages).where(and(
        eq(messages.threadId, threadId),
        sql`json_extract(${messages.systemNotice}, '$.scope') = 'session'`,
        sql`json_extract(${messages.systemNotice}, '$.sessionId') IS NOT ${sessionId ?? null}`,
      )).run();
    })();
  }

  /** Read the latest notices for the provider session selected at its startup boundary. */
  listSessionNotices(threadId: string): Message[] {
    const latest = this.orm.select().from(messages).where(and(
      eq(messages.threadId, threadId),
      isNotNull(messages.systemNotice),
      sql`json_extract(${messages.systemNotice}, '$.sessionId') IS (
        SELECT ${threads.currentNoticeSessionId} FROM ${threads} WHERE ${threads.id} = ${threadId}
      )`,
    )).orderBy(desc(messages.sequence)).limit(20).as("latest_notices");
    const rows = this.orm.select().from(latest).orderBy(asc(latest.sequence)).all();
    return rows.map((row) => rowToMessage(row as MessageRow));
  }

  /**
   * Insert an assistant message under a caller-supplied deterministic `id`,
   * skipping the write when a row with that id already exists.
   *
   * This mirrors the `INSERT OR IGNORE` pattern the narrative tables use
   * (see {@link ToolCallRecordRepo}). Because the turn's assistant message has a
   * deterministic per-turn identity, a replayed write — a re-run finalize, a
   * retry, or a reconnect replay — collapses onto the same id and is a no-op
   * rather than a duplicate row. The first write wins; a later ignored write
   * does not overwrite its content. The returned record reflects the supplied
   * values (the caller already holds the deterministic id, so re-reading the
   * stored row is unnecessary). Note: on an ignored write the returned
   * `content`, `sequence`, and `timestamp` reflect this call's arguments, not
   * the row already in the database — re-read from the DB if you need the
   * authoritative stored values.
   */
  createAssistantIdempotent(input: {
    id: string;
    threadId: string;
    content: string;
    sequence: number;
    model?: string | null;
    provider?: string | null;
    attachments?: StoredAttachment[];
    mentions?: MessageMention[];
    isInternal?: boolean;
  }): Message {
    const now = new Date().toISOString();
    const modelValue = input.model ?? null;
    const providerValue = input.provider ?? null;
    const attachmentsJson = this.serializeNonEmptyArray(input.attachments);
    const mentionsJson = this.serializeNonEmptyArray(input.mentions);

    const result = runChanges(this.getCreateAssistantStatement(), {
      id: input.id,
      threadId: input.threadId,
      content: input.content,
      timestamp: now,
      sequence: input.sequence,
      attachments: attachmentsJson,
      mentions: mentionsJson,
      model: modelValue,
      provider: providerValue,
      isInternal: input.isInternal ? 1 : 0,
    });

    const attachments = this.assistantAttachments(result, input.id, input.attachments);
    return this.createdMessage({
      id: input.id,
      threadId: input.threadId,
      role: "assistant",
      content: input.content,
      sequence: input.sequence,
      timestamp: now,
      attachments,
      mentions: input.mentions,
      model: modelValue,
      isInternal: input.isInternal,
    });
  }

  private serializeNonEmptyArray<T>(value: readonly T[] | undefined): string | null {
    return value && value.length > 0 ? JSON.stringify(value) : null;
  }

  private messageSource(origin: MessageOriginInput): {
    threadId: string | null;
    turnId: string | null;
    providerId: string | null;
  } {
    if (origin.type !== "thread") return { threadId: null, turnId: null, providerId: null };
    return {
      threadId: origin.sourceThreadId,
      turnId: origin.sourceTurnId,
      providerId: origin.sourceProviderId,
    };
  }

  private createdMessage(input: {
    id: string;
    threadId: string;
    role: MessageRole;
    content: string;
    sequence: number;
    timestamp: string;
    attachments?: StoredAttachment[] | null;
    previewAnnotations?: PreviewAnnotationBundle | null;
    mentions?: MessageMention[] | null;
    selectedTextComments?: SelectedTextComment[] | null;
    replyToMessageId?: string;
    quotedText?: string;
    model?: string | null;
    isInternal?: boolean;
    systemNotice?: SystemNoticeMetadata | null;
  }): Message {
    return {
      id: input.id,
      thread_id: input.threadId,
      role: input.role,
      content: input.content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: input.timestamp,
      sequence: input.sequence,
      attachments: input.attachments ?? null,
      previewAnnotations: input.previewAnnotations ?? null,
      mentions: input.mentions ?? null,
      selectedTextComments: input.selectedTextComments ?? null,
      reply_to_message_id: input.replyToMessageId ?? null,
      quoted_text: input.quotedText ?? null,
      model: input.model ?? null,
      is_internal: input.isInternal ?? false,
      outcome: null,
      outcomeExecutionId: null,
      systemNotice: input.systemNotice ?? null,
    };
  }

  private assistantAttachments(
    result: Changes,
    messageId: string,
    attachments: StoredAttachment[] | undefined,
  ): StoredAttachment[] | null {
    if (result.changes === 0 && attachments && attachments.length > 0) {
      return this.appendAttachments(messageId, attachments);
    }
    return attachments ?? null;
  }

  /** Persist a terminal outcome after the turn finalizer proves the turn ended. */
  setAssistantOutcome(messageId: string, outcome: TurnOutcome, executionId?: string): void {
    this.orm.update(messages)
      .set({ outcome, outcomeExecutionId: executionId ?? null })
      .where(and(eq(messages.id, messageId), eq(messages.role, "assistant")))
      .run();
  }

  /** Make a staged assistant message visible after its terminal checkpoint commits. */
  publishAssistant(messageId: string): void {
    this.getPublishAssistantStatement().run({ id: messageId });
  }

  /** Return the newest sequence in a thread, including internal rows. */
  getLatestSequenceIncludingInternal(threadId: string): number {
    const row = this.getLatestSequenceStatement().get({ threadId });
    return row?.sequence ?? 0;
  }

  /** Append stored attachments to an existing message, deduping by attachment id. */
  appendAttachments(messageId: string, attachments: StoredAttachment[]): StoredAttachment[] {
    if (attachments.length === 0) return [];
    const row = this.orm
      .select({ attachments: messages.attachments })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.isInternal, 0)))
      .get();
    const parsed = parseJsonField(row?.attachments ?? null);
    const existing = Array.isArray(parsed)
      ? (parsed as StoredAttachment[])
      : [];
    const byId = new Map(existing.map((att) => [att.id, att]));
    for (const att of attachments) {
      byId.set(att.id, att);
    }
    const merged = [...byId.values()];
    this.orm.update(messages)
      .set({ attachments: merged.length > 0 ? JSON.stringify(merged) : null })
      .where(and(eq(messages.id, messageId), eq(messages.isInternal, 0)))
      .run();
    return merged;
  }

  /**
   * Return the last N messages for a thread in ascending sequence order.
   *
   * Uses a sub-select pattern: grab the last N rows by descending sequence,
   * then re-sort ascending so the caller gets chronological order.
   *
   * When `before` is provided, only messages with sequence < before are
   * considered, enabling cursor-based pagination for older messages.
   *
   * Returns `{ messages, hasMore }` where hasMore indicates whether
   * older messages exist beyond this batch (uses limit+1 trick).
   */
  listByThread(
    threadId: string,
    limit: number,
    before?: number,
  ): { messages: Message[]; hasMore: boolean } {
    const clampedLimit = Math.max(1, Math.min(1000, limit));
    const fetchLimit = clampedLimit + 1;

    let rows = this.pageWithToolCounts(
      and(
        eq(messages.threadId, threadId),
        ...(before != null ? [lt(messages.sequence, before)] : []),
        eq(messages.isInternal, 0),
        notSessionNotice,
      ),
      "DESC",
      fetchLimit,
    );

    const hasMore = rows.length > clampedLimit;
    if (hasMore) {
      rows = rows.slice(rows.length - clampedLimit);
    }

    return { messages: rows.map(rowToMessage), hasMore };
  }

  /**
   * Fetch a bounded page of messages and attach per-message tool call counts.
   * One grouped count query over the page ids replaces a correlated count
   * that would otherwise run once per row.
   */
  private pageWithToolCounts(
    where: SQL | undefined,
    direction: "ASC" | "DESC",
    limit: number,
  ): MessageRow[] {
    const rows = this.orm
      .select()
      .from(messages)
      .where(where)
      .orderBy(direction === "ASC" ? asc(messages.sequence) : desc(messages.sequence))
      .limit(limit)
      .all();
    if (rows.length === 0) return [];
    const counts = this.orm
      .select({ messageId: toolCallRecords.messageId, toolCallCount: count() })
      .from(toolCallRecords)
      .where(inArray(toolCallRecords.messageId, rows.map((row) => row.id)))
      .groupBy(toolCallRecords.messageId)
      .all();
    const countByMessageId = new Map(counts.map((row) => [row.messageId, row.toolCallCount]));
    return rows
      .map((row) => ({ ...row, toolCallCount: countByMessageId.get(row.id) ?? 0 }))
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** Return the first N messages after a sequence cursor in ascending order. */
  listByThreadAfter(
    threadId: string,
    limit: number,
    after: number,
  ): { messages: Message[]; hasMore: boolean } {
    const clampedLimit = Math.max(1, Math.min(1000, limit));
    const fetchLimit = clampedLimit + 1;
    let rows = this.pageWithToolCounts(
      and(
        eq(messages.threadId, threadId),
        gt(messages.sequence, after),
        eq(messages.isInternal, 0),
        notSessionNotice,
      ),
      "ASC",
      fetchLimit,
    );

    const hasMore = rows.length > clampedLimit;
    if (hasMore) rows = rows.slice(0, clampedLimit);
    return { messages: rows.map(rowToMessage), hasMore };
  }

  /** Return a bounded newest transcript window with persisted provenance fields. */
  listByThreadForThreadControl(
    threadId: string,
    limit: number,
    maxBytes = THREAD_GET_TRANSCRIPT_MAX_BYTES,
  ): { messages: ThreadControlMessageRecord[]; hasMore: boolean } {
    const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const byteBudget = Number.isFinite(maxBytes)
      ? Math.max(1, Math.min(THREAD_GET_TRANSCRIPT_MAX_BYTES, Math.floor(maxBytes)))
      : THREAD_GET_TRANSCRIPT_MAX_BYTES;
    const rows = this.orm.select({
      id: messages.id,
      sequence: messages.sequence,
      role: messages.role,
      contentBytes: sql<number>`length(CAST(${messages.content} AS BLOB))`.mapWith(Number),
      timestamp: messages.timestamp,
      provider: messages.provider,
      model: messages.model,
      originType: messages.originType,
      sourceThreadId: messages.sourceThreadId,
      sourceTurnId: messages.sourceTurnId,
      sourceProviderId: messages.sourceProviderId,
    }).from(messages).where(and(
      eq(messages.threadId, threadId),
      eq(messages.isInternal, 0),
      notSessionNotice,
    )).orderBy(desc(messages.sequence)).limit(clampedLimit + 1).all();
    let hasMore = rows.length > clampedLimit;
    const selected: Array<typeof rows[number] & { contentLimit?: number }> = [];
    let remainingBytes = byteBudget;
    for (const row of rows.slice(0, clampedLimit)) {
      const contentBytes = Math.max(0, row.contentBytes ?? 0);
      if (contentBytes <= remainingBytes) {
        selected.push(row);
        remainingBytes -= contentBytes;
        continue;
      }
      if (selected.length === 0) {
        selected.push({ ...row, contentLimit: remainingBytes });
      }
      hasMore = true;
      break;
    }
    const transcriptFields = {
      id: messages.id,
      role: messages.role,
      content: messages.content,
      timestamp: messages.timestamp,
      provider: messages.provider,
      model: messages.model,
      originType: messages.originType,
      sourceThreadId: messages.sourceThreadId,
      sourceTurnId: messages.sourceTurnId,
      sourceProviderId: messages.sourceProviderId,
    };
    const messageRows = selected
      .sort((left, right) => left.sequence - right.sequence)
      .flatMap((row) => {
        const fetched = row.contentLimit === undefined
          ? this.orm.select(transcriptFields).from(messages)
              .where(and(eq(messages.id, row.id), eq(messages.threadId, threadId), eq(messages.isInternal, 0)))
              .get()
          : this.orm.select({ ...transcriptFields, content: sql<string>`substr(${messages.content}, 1, ${row.contentLimit})` }).from(messages)
              .where(and(eq(messages.id, row.id), eq(messages.threadId, threadId), eq(messages.isInternal, 0)))
              .get();
        if (!fetched) return [];
        const contentRow = fetched as typeof fetched & { role: "user" | "assistant" | "system" };
        const prefix = row.contentLimit === undefined
          ? contentRow.content
          : takeUtf8Prefix(contentRow.content, row.contentLimit).text;
        return [{
          id: contentRow.id,
          role: contentRow.role,
          content: prefix,
          timestamp: contentRow.timestamp,
          provider: contentRow.provider,
          model: contentRow.model,
          originType: contentRow.originType === "composer" || contentRow.originType === "thread" ? contentRow.originType : "legacy",
          sourceThreadId: contentRow.sourceThreadId,
          sourceTurnId: contentRow.sourceTurnId,
          sourceProviderId: contentRow.sourceProviderId,
        } satisfies ThreadControlMessageRecord];
      });
    return {
      messages: messageRows,
      hasMore,
    };
  }

  /**
   * Return ALL messages for a thread with sequence <= maxSequence,
   * in ascending sequence order. No row limit — used for fork resolution
   * where the full history up to the fork point is needed.
   *
   * Callers must enforce an upper bound on `maxSequence` or total rows
   * (see `AgentService` fork guard) so pathological threads cannot OOM the server.
   */
  listByThreadUpToSequence(
    threadId: string,
    maxSequence: number,
  ): Message[] {
    const rows = this.threadMessagesWithToolCounts(
      and(eq(messages.threadId, threadId), lte(messages.sequence, maxSequence), eq(messages.isInternal, 0)),
      and(
        eq(messages.threadId, threadId),
        lte(messages.sequence, maxSequence),
        eq(messages.isInternal, 0),
        notSessionNotice,
      ),
    );

    return rows.map(rowToMessage);
  }

  /**
   * Attach tool call counts to an unbounded thread message scan.
   * The counts subquery stays in SQL because the id list can exceed the
   * SQLite bound-parameter limit on large threads.
   */
  private threadMessagesWithToolCounts(countsWhere: SQL | undefined, outerWhere: SQL | undefined): MessageRow[] {
    const counts = this.orm
      .select({
        messageId: toolCallRecords.messageId,
        toolCallCount: count().as("tool_call_count"),
      })
      .from(toolCallRecords)
      .where(inArray(
        toolCallRecords.messageId,
        this.orm.select({ id: messages.id }).from(messages).where(countsWhere),
      ))
      .groupBy(toolCallRecords.messageId)
      .as("counts");
    return this.orm
      .select({
        ...getTableColumns(messages),
        toolCallCount: sql<number>`COALESCE(${counts.toolCallCount}, 0)`.mapWith(Number),
      })
      .from(messages)
      .leftJoin(counts, eq(counts.messageId, messages.id))
      .where(outerWhere)
      .orderBy(asc(messages.sequence))
      .all() as MessageRow[];
  }

  /**
   * Return the newest messages at or before `maxSequence` under a byte budget.
   * Reads lightweight metadata in reverse pages, then fetches only retained rows.
   */
  listByThreadUpToSequenceBudgeted(
    threadId: string,
    maxSequence: number,
    options: BudgetedThreadMessageOptions,
  ): BudgetedThreadMessages {
    const { budgetBytes, pageSize, maxRows, visibilityConditions } =
      this.budgetedHistoryOptions(options);

    const pageRows = (cursor: number) => this.orm.select({
      id: messages.id,
      sequence: messages.sequence,
      contentBytes: sql<number>`length(CAST(${messages.content} AS BLOB))`.mapWith(Number),
      metadataBytes: sql<number>`(
        length(CAST(COALESCE(${messages.filesChanged}, '') AS BLOB)) +
        length(CAST(COALESCE(${messages.attachments}, '') AS BLOB)) +
        length(CAST(COALESCE(${messages.mentions}, '') AS BLOB)) +
        length(CAST(COALESCE(${messages.selectedTextComments}, '') AS BLOB)) +
        length(CAST(COALESCE(${messages.quotedText}, '') AS BLOB))
      )`.mapWith(Number),
    }).from(messages).where(and(
      eq(messages.threadId, threadId),
      lte(messages.sequence, maxSequence),
      lt(messages.sequence, cursor),
      ...visibilityConditions,
    )).orderBy(desc(messages.sequence)).limit(pageSize).all();

    const countBefore = (sequence: number) => this.orm
      .select({ count: count() })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), lt(messages.sequence, sequence), ...visibilityConditions))
      .get()?.count ?? 0;
    const countAtOrBefore = (sequence: number) => this.orm
      .select({ count: count() })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), lte(messages.sequence, sequence), ...visibilityConditions))
      .get()?.count ?? 0;

    const selected: Array<{
      id: string;
      sequence: number;
      originalBytes: number;
      truncateContentToBytes?: number;
    }> = [];
    const truncatedMessages: ThreadHistoryBudget["truncatedMessages"] = [];
    let retainedBytes = 0;
    let cursor = maxSequence + 1;
    let omittedBeforeCount = 0;

    while (true) {
      const rows = pageRows(cursor);
      if (rows.length === 0) break;

      for (const row of rows) {
        const contentBytes = Math.max(0, row.contentBytes ?? 0);
        const metadataBytes = Math.max(0, row.metadataBytes ?? 0);
        const rowBytes = contentBytes + metadataBytes;
        const rowCost = Math.max(1, rowBytes);

        if (retainedBytes + rowCost <= budgetBytes) {
          if (selected.length >= maxRows) {
            omittedBeforeCount = countAtOrBefore(row.sequence);
            const fetched = this.fetchBudgetedMessages(selected, truncatedMessages);
            return {
              messages: fetched.messages,
              budget: {
                budgetBytes,
                retainedBytes: retainedBytes + fetched.retainedBytesDelta,
                omittedBeforeCount,
                truncatedMessages,
              },
            };
          }
          selected.push({ id: row.id, sequence: row.sequence, originalBytes: contentBytes });
          retainedBytes += rowCost;
          continue;
        }

        if (selected.length === 0) {
          const contentBudget = Math.max(0, budgetBytes - metadataBytes);
          selected.push({
            id: row.id,
            sequence: row.sequence,
            originalBytes: contentBytes,
            truncateContentToBytes: contentBudget,
          });
          retainedBytes = Math.min(budgetBytes, metadataBytes + contentBudget);
          truncatedMessages.push({
            id: row.id,
            originalBytes: contentBytes,
            retainedBytes: contentBudget,
          });
          omittedBeforeCount = countBefore(row.sequence);
        } else {
          omittedBeforeCount = countAtOrBefore(row.sequence);
        }

        const fetched = this.fetchBudgetedMessages(selected, truncatedMessages);
        return {
          messages: fetched.messages,
          budget: {
            budgetBytes,
            retainedBytes: retainedBytes + fetched.retainedBytesDelta,
            omittedBeforeCount,
            truncatedMessages,
          },
        };
      }

      cursor = rows[rows.length - 1]!.sequence;
    }

    return {
      messages: this.fetchBudgetedMessages(selected, truncatedMessages).messages,
      budget: {
        budgetBytes,
        retainedBytes,
        omittedBeforeCount,
        truncatedMessages,
      },
    };
  }

  private budgetedHistoryOptions(options: BudgetedThreadMessageOptions): {
    budgetBytes: number;
    pageSize: number;
    maxRows: number;
    visibilityConditions: SQL[];
  } {
    const includeInternal = options.includeInternal === true;
    return {
      budgetBytes: clampPositiveInt(options.maxBytes, 1, Number.MAX_SAFE_INTEGER),
      pageSize: clampPositiveInt(
        options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE,
        DEFAULT_HISTORY_PAGE_SIZE,
        MAX_HISTORY_PAGE_SIZE,
      ),
      maxRows: clampPositiveInt(
        options.maxRows ?? DEFAULT_HISTORY_MAX_ROWS,
        DEFAULT_HISTORY_MAX_ROWS,
        MAX_HISTORY_MAX_ROWS,
      ),
      visibilityConditions: includeInternal ? [] : [eq(messages.isInternal, 0), notSessionNotice],
    };
  }

  private fetchBudgetedMessages(
    selected: Array<{
      id: string;
      sequence: number;
      originalBytes: number;
      truncateContentToBytes?: number;
    }>,
    truncatedMessages: ThreadHistoryBudget["truncatedMessages"],
  ): { messages: Message[]; retainedBytesDelta: number } {
    const budgetedFields = {
      id: messages.id,
      threadId: messages.threadId,
      role: messages.role,
      content: messages.content,
      toolCalls: sql<string | null>`NULL`,
      filesChanged: messages.filesChanged,
      costUsd: messages.costUsd,
      tokensUsed: messages.tokensUsed,
      timestamp: messages.timestamp,
      sequence: messages.sequence,
      attachments: messages.attachments,
      previewAnnotations: messages.previewAnnotations,
      mentions: messages.mentions,
      selectedTextComments: messages.selectedTextComments,
      replyToMessageId: messages.replyToMessageId,
      quotedText: messages.quotedText,
      model: messages.model,
      provider: sql<string | null>`NULL`,
      originType: sql<string>`NULL`,
      sourceThreadId: sql<string | null>`NULL`,
      sourceTurnId: sql<string | null>`NULL`,
      sourceProviderId: sql<string | null>`NULL`,
      legacyProvenance: sql<string | null>`NULL`,
      parentAgentProvenance: sql<string | null>`NULL`,
      isInternal: messages.isInternal,
      outcome: messages.outcome,
      outcomeExecutionId: messages.outcomeExecutionId,
      systemNotice: messages.systemNotice,
      toolCallCount: sql<number>`(SELECT COUNT(*) FROM ${toolCallRecords} WHERE ${toolCallRecords.messageId} = ${messages.id})`.mapWith(Number),
    };

    let retainedBytesDelta = 0;
    const fetched = selected
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => {
        if (item.truncateContentToBytes === undefined) {
          const row = this.orm.select(budgetedFields).from(messages).where(eq(messages.id, item.id)).get() as MessageRow;
          return rowToMessage(row);
        }

        const row = this.orm.select({ ...budgetedFields, content: sql<string>`substr(${messages.content}, 1, ${item.truncateContentToBytes})` }).from(messages).where(eq(messages.id, item.id)).get() as MessageRow;
        const prefix = takeUtf8Prefix(row.content, item.truncateContentToBytes);
        row.content = prefix.text;
        const truncated = rowToMessage(row);
        const tracked = item.truncateContentToBytes;
        if (tracked !== prefix.bytes) {
          retainedBytesDelta += prefix.bytes - tracked;
          const budgetEntry = truncatedMessages.find((entry) => entry.id === item.id);
          if (budgetEntry) budgetEntry.retainedBytes = prefix.bytes;
          truncated.content = prefix.text;
        }
        return truncated;
      });
    return { messages: fetched, retainedBytesDelta };
  }

  /** Find a single message by ID within a specific thread. Returns null if not found. */
  findByIdInThread(threadId: string, messageId: string): Message | null {
    const row = this.orm
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.threadId, threadId), eq(messages.isInternal, 0)))
      .get();

    return row ? rowToMessage(row) : null;
  }

  /** Look up a single message by its primary key. */
  findById(id: string): Message | undefined {
    const row = this.orm
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), eq(messages.isInternal, 0)))
      .get();
    return row ? rowToMessage(row) : undefined;
  }

  /**
   * Return ALL messages for a thread in ascending sequence order, including
   * those marked `is_internal = 1`.
   *
   * For internal/pipeline use only (e.g. handoff reconstruction, provider
   * session replay). Never feed this output directly to the chat UI — use
   * `listByThread` instead, which filters out internal messages.
   */
  listIncludingInternal(threadId: string): Message[] {
    const threadFilter = eq(messages.threadId, threadId);
    const rows = this.threadMessagesWithToolCounts(threadFilter, threadFilter);
    return rows.map(rowToMessage);
  }
}
