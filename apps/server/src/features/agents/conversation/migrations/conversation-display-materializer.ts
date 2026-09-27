import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { and, asc, count, eq, inArray, isNotNull, like, or, placeholder, sql } from "drizzle-orm";
import {
  canonicalAgentIngestCheckpoints,
  canonicalAgentItems,
  canonicalConversationDisplayMappings,
  conversationDisplayMaterializationState,
  hookExecutions,
  messages,
  thoughtSegments,
  toolCallRecords,
} from "../../../../runtime/persistence/sqlite/schema.js";
import type { Message } from "@mcode/contracts";

const MATERIALIZATION_STATE_ID = 1;
const MATERIALIZATION_BATCH_ITEMS = 100;
const MATERIALIZATION_BATCH_BYTES = 1_048_576;

interface CanonicalItemRow {
  id: string;
  threadId: string;
  turnId: string;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
}

interface NarrativePayload {
  projection?: string;
  message?: Message;
  record?: Record<string, unknown>;
  narrative?: { kind?: string; record?: Record<string, unknown> };
  nativeItemId?: string;
  toolName?: string;
  toolInput?: unknown;
  output?: string;
  isError?: boolean;
  content?: string;
}

interface DisplayToolRecord {
  id: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  sortOrder: number;
}

interface NarrativeDisplayResolver {
  childAnchor(): string | null;
  recoveryAnchor(): string | null;
  displayMessageId(value: unknown, row: CanonicalItemRow): string | null;
}

/**
 * Writes display-table projections for canonical conversation items before the
 * server admits provider work. The mapping stores identities only, so canonical
 * provenance remains the single durable source for materialized rows.
 */
export class ConversationDisplayMaterializer {
  private readonly orm: BunSQLiteDatabase;
  private readonly insertMessage: ReturnType<ConversationDisplayMaterializer["buildInsertMessage"]>;
  private readonly insertTool: ReturnType<ConversationDisplayMaterializer["buildInsertTool"]>;
  private readonly insertThought: ReturnType<ConversationDisplayMaterializer["buildInsertThought"]>;
  private readonly insertHook: ReturnType<ConversationDisplayMaterializer["buildInsertHook"]>;
  private readonly mapSource: ReturnType<ConversationDisplayMaterializer["buildMapSource"]>;
  private readonly findChildMessage: ReturnType<ConversationDisplayMaterializer["buildFindChildMessage"]>;
  private readonly findCanonicalMessage: ReturnType<ConversationDisplayMaterializer["buildFindCanonicalMessage"]>;
  private readonly findDisplayMessage: ReturnType<ConversationDisplayMaterializer["buildFindDisplayMessage"]>;
  private readonly findTerminalCheckpoint: ReturnType<ConversationDisplayMaterializer["buildFindTerminalCheckpoint"]>;

  constructor(private readonly db: Database) {
    this.orm = drizzle(db);
    this.insertMessage = this.buildInsertMessage();
    this.insertTool = this.buildInsertTool();
    this.insertThought = this.buildInsertThought();
    this.insertHook = this.buildInsertHook();
    this.mapSource = this.buildMapSource();
    this.findChildMessage = this.buildFindChildMessage();
    this.findCanonicalMessage = this.buildFindCanonicalMessage();
    this.findDisplayMessage = this.buildFindDisplayMessage();
    this.findTerminalCheckpoint = this.buildFindTerminalCheckpoint();
  }

  private buildInsertMessage() {
    return this.orm.insert(messages).values({
      id: placeholder("id"),
      threadId: placeholder("threadId"),
      role: placeholder("role"),
      content: placeholder("content"),
      toolCalls: placeholder("toolCalls"),
      filesChanged: placeholder("filesChanged"),
      costUsd: placeholder("costUsd"),
      tokensUsed: placeholder("tokensUsed"),
      timestamp: placeholder("timestamp"),
      sequence: placeholder("sequence"),
      attachments: placeholder("attachments"),
      previewAnnotations: placeholder("previewAnnotations"),
      mentions: placeholder("mentions"),
      selectedTextComments: placeholder("selectedTextComments"),
      replyToMessageId: placeholder("replyToMessageId"),
      quotedText: placeholder("quotedText"),
      model: placeholder("model"),
      originType: placeholder("originType"),
      sourceThreadId: placeholder("sourceThreadId"),
      sourceTurnId: placeholder("sourceTurnId"),
      sourceProviderId: placeholder("sourceProviderId"),
      legacyProvenance: placeholder("legacyProvenance"),
      parentAgentProvenance: placeholder("parentAgentProvenance"),
      isInternal: placeholder("isInternal"),
      outcome: placeholder("outcome"),
      outcomeExecutionId: placeholder("outcomeExecutionId"),
      systemNotice: placeholder("systemNotice"),
    }).onConflictDoUpdate({
      target: messages.id,
      set: {
        role: sql`excluded.role`,
        content: sql`excluded.content`,
        toolCalls: sql`excluded.tool_calls`,
        filesChanged: sql`excluded.files_changed`,
        costUsd: sql`excluded.cost_usd`,
        tokensUsed: sql`excluded.tokens_used`,
        timestamp: sql`excluded.timestamp`,
        sequence: sql`excluded.sequence`,
        attachments: sql`excluded.attachments`,
        previewAnnotations: sql`excluded.preview_annotations`,
        mentions: sql`excluded.mentions`,
        selectedTextComments: sql`COALESCE(excluded.selected_text_comments, ${messages.selectedTextComments})`,
        replyToMessageId: sql`excluded.reply_to_message_id`,
        quotedText: sql`excluded.quoted_text`,
        model: sql`excluded.model`,
        originType: sql`CASE
          WHEN excluded.origin_type = 'canonical' AND ${messages.originType} <> 'canonical'
            THEN ${messages.originType}
          ELSE excluded.origin_type
        END`,
        sourceThreadId: sql`COALESCE(excluded.source_thread_id, ${messages.sourceThreadId})`,
        sourceTurnId: sql`COALESCE(excluded.source_turn_id, ${messages.sourceTurnId})`,
        sourceProviderId: sql`COALESCE(excluded.source_provider_id, ${messages.sourceProviderId})`,
        legacyProvenance: sql`COALESCE(excluded.legacy_provenance, ${messages.legacyProvenance})`,
        isInternal: sql`excluded.is_internal`,
        parentAgentProvenance: sql`COALESCE(excluded.parent_agent_provenance, ${messages.parentAgentProvenance})`,
        outcome: sql`COALESCE(excluded.outcome, ${messages.outcome})`,
        outcomeExecutionId: sql`COALESCE(excluded.outcome_execution_id, ${messages.outcomeExecutionId})`,
        systemNotice: sql`COALESCE(excluded.system_notice, ${messages.systemNotice})`,
      },
    }).prepare();
  }

  private buildInsertTool() {
    return this.orm.insert(toolCallRecords).values({
      id: placeholder("id"),
      messageId: placeholder("messageId"),
      parentToolCallId: placeholder("parentToolCallId"),
      toolName: placeholder("toolName"),
      displayName: placeholder("displayName"),
      providerAgentKey: placeholder("providerAgentKey"),
      subagentIdentityKey: placeholder("subagentIdentityKey"),
      subagentProviderName: placeholder("subagentProviderName"),
      subagentPrompt: placeholder("subagentPrompt"),
      subagentType: placeholder("subagentType"),
      subagentAgentId: placeholder("subagentAgentId"),
      subagentDurationMs: placeholder("subagentDurationMs"),
      model: placeholder("model"),
      reasoningEffort: placeholder("reasoningEffort"),
      inputSummary: placeholder("inputSummary"),
      // Bun strips a leading BOM from bound text. The old display table can
      // contain one, so construct that first character inside SQLite.
      outputSummary: sql`CASE WHEN ${placeholder("outputStartsWithBom")} THEN char(65279) || ${placeholder("outputSummaryTail")} ELSE ${placeholder("outputSummary")} END`,
      outputTruncated: placeholder("outputTruncated"),
      outputTotalBytes: placeholder("outputTotalBytes"),
      outputArtifactPath: placeholder("outputArtifactPath"),
      exitCode: placeholder("exitCode"),
      status: placeholder("status"),
      startedAt: placeholder("startedAt"),
      completedAt: placeholder("completedAt"),
      sortOrder: placeholder("sortOrder"),
    }).onConflictDoUpdate({
      target: toolCallRecords.id,
      set: {
        messageId: sql`excluded.message_id`,
        parentToolCallId: sql`excluded.parent_tool_call_id`,
        toolName: sql`excluded.tool_name`,
        displayName: sql`excluded.display_name`,
        providerAgentKey: sql`excluded.provider_agent_key`,
        subagentIdentityKey: sql`excluded.subagent_identity_key`,
        subagentProviderName: sql`excluded.subagent_provider_name`,
        subagentPrompt: sql`excluded.subagent_prompt`,
        subagentType: sql`excluded.subagent_type`,
        subagentAgentId: sql`excluded.subagent_agent_id`,
        subagentDurationMs: sql`excluded.subagent_duration_ms`,
        model: sql`excluded.model`,
        reasoningEffort: sql`excluded.reasoning_effort`,
        inputSummary: sql`excluded.input_summary`,
        outputSummary: sql`excluded.output_summary`,
        outputTruncated: sql`excluded.output_truncated`,
        outputTotalBytes: sql`excluded.output_total_bytes`,
        outputArtifactPath: sql`excluded.output_artifact_path`,
        exitCode: sql`excluded.exit_code`,
        status: sql`excluded.status`,
        startedAt: sql`excluded.started_at`,
        completedAt: sql`excluded.completed_at`,
        sortOrder: sql`excluded.sort_order`,
      },
    }).prepare();
  }

  private buildInsertThought() {
    return this.orm.insert(thoughtSegments).values({
      id: placeholder("id"),
      messageId: placeholder("messageId"),
      text: placeholder("text"),
      startedAt: placeholder("startedAt"),
      endedAt: placeholder("endedAt"),
      sortOrder: placeholder("sortOrder"),
      isFinalResponse: placeholder("isFinalResponse"),
    }).onConflictDoUpdate({
      target: thoughtSegments.id,
      set: {
        messageId: sql`excluded.message_id`,
        text: sql`excluded.text`,
        startedAt: sql`excluded.started_at`,
        endedAt: sql`excluded.ended_at`,
        sortOrder: sql`excluded.sort_order`,
        isFinalResponse: sql`excluded.is_final_response`,
      },
    }).prepare();
  }

  private buildInsertHook() {
    return this.orm.insert(hookExecutions).values({
      id: placeholder("id"),
      messageId: placeholder("messageId"),
      hookName: placeholder("hookName"),
      toolName: placeholder("toolName"),
      phase: placeholder("phase"),
      payload: placeholder("payload"),
      durationMs: placeholder("durationMs"),
      didBlock: placeholder("didBlock"),
      startedAt: placeholder("startedAt"),
      endedAt: placeholder("endedAt"),
      sortOrder: placeholder("sortOrder"),
    }).onConflictDoUpdate({
      target: hookExecutions.id,
      set: {
        messageId: sql`excluded.message_id`,
        hookName: sql`excluded.hook_name`,
        toolName: sql`excluded.tool_name`,
        phase: sql`excluded.phase`,
        payload: sql`excluded.payload`,
        durationMs: sql`excluded.duration_ms`,
        didBlock: sql`excluded.did_block`,
        startedAt: sql`excluded.started_at`,
        endedAt: sql`excluded.ended_at`,
        sortOrder: sql`excluded.sort_order`,
      },
    }).prepare();
  }

  private buildMapSource() {
    return this.orm.insert(canonicalConversationDisplayMappings).values({
      sourceItemId: placeholder("sourceItemId"),
      targetKind: placeholder("targetKind"),
      targetId: placeholder("targetId"),
      sourceUpdatedAt: placeholder("sourceUpdatedAt"),
      updatedAt: placeholder("updatedAt"),
    }).onConflictDoUpdate({
      target: canonicalConversationDisplayMappings.sourceItemId,
      set: {
        targetKind: sql`excluded.target_kind`,
        targetId: sql`excluded.target_id`,
        sourceUpdatedAt: sql`excluded.source_updated_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    }).prepare();
  }

  /** Materializes every canonical row in bounded, restart-safe transactions. */
  async runToCompletion(): Promise<void> {
    this.orm.insert(conversationDisplayMaterializationState)
      .values({ id: MATERIALIZATION_STATE_ID, completed: 0 })
      .onConflictDoNothing()
      .run();

    while (true) {
      const batch = this.nextBatch();
      if (batch.length === 0) {
        this.orm.update(conversationDisplayMaterializationState)
          .set({ completed: 1, updatedAt: new Date().toISOString() })
          .where(eq(conversationDisplayMaterializationState.id, MATERIALIZATION_STATE_ID))
          .run();
        return;
      }
      this.db.transaction(() => {
        for (const row of batch) this.materializeRow(row);
        const last = batch.at(-1)!;
        this.orm.update(conversationDisplayMaterializationState)
          .set({
            lastSourceCreatedAt: last.createdAt,
            lastSourceId: last.id,
            completed: 0,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(conversationDisplayMaterializationState.id, MATERIALIZATION_STATE_ID))
          .run();
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Writes newly persisted canonical items in the caller's existing transaction. */
  materializeItems(itemIds: readonly string[]): void {
    if (itemIds.length === 0) return;
    const rows = this.orm.select({
      id: canonicalAgentItems.id,
      threadId: canonicalAgentItems.threadId,
      turnId: canonicalAgentItems.turnId,
      payloadJson: canonicalAgentItems.payloadJson,
      createdAt: canonicalAgentItems.createdAt,
      updatedAt: canonicalAgentItems.updatedAt,
    }).from(canonicalAgentItems)
      .where(inArray(canonicalAgentItems.id, itemIds))
      .orderBy(asc(canonicalAgentItems.createdAt), asc(canonicalAgentItems.id))
      .all();
    for (const row of rows) this.materializeRow(row);
  }

  /** Removes a discarded canonical recovery projection and its orphaned display row. */
  discardItem(itemId: string): void {
    const mapping = this.orm.select({
      targetKind: canonicalConversationDisplayMappings.targetKind,
      targetId: canonicalConversationDisplayMappings.targetId,
    }).from(canonicalConversationDisplayMappings)
      .where(eq(canonicalConversationDisplayMappings.sourceItemId, itemId))
      .get();
    if (!mapping) return;
    this.orm.delete(canonicalConversationDisplayMappings)
      .where(eq(canonicalConversationDisplayMappings.sourceItemId, itemId))
      .run();
    const remaining = this.orm.select({ sourceItemId: canonicalConversationDisplayMappings.sourceItemId })
      .from(canonicalConversationDisplayMappings)
      .where(and(
        eq(canonicalConversationDisplayMappings.targetKind, mapping.targetKind),
        eq(canonicalConversationDisplayMappings.targetId, mapping.targetId),
      ))
      .limit(1)
      .get();
    if (remaining) return;
    const table = displayTableFor(mapping.targetKind);
    if (table) this.orm.delete(table).where(eq(table.id, mapping.targetId)).run();
  }

  private nextBatch(): CanonicalItemRow[] {
    const state = this.orm.select({
      lastSourceCreatedAt: conversationDisplayMaterializationState.lastSourceCreatedAt,
      lastSourceId: conversationDisplayMaterializationState.lastSourceId,
    }).from(conversationDisplayMaterializationState)
      .where(eq(conversationDisplayMaterializationState.id, MATERIALIZATION_STATE_ID))
      .get();
    const itemColumns = {
      id: canonicalAgentItems.id,
      threadId: canonicalAgentItems.threadId,
      turnId: canonicalAgentItems.turnId,
      payloadJson: canonicalAgentItems.payloadJson,
      createdAt: canonicalAgentItems.createdAt,
      updatedAt: canonicalAgentItems.updatedAt,
    };
    const rows = state?.lastSourceCreatedAt && state.lastSourceId
      ? this.orm.select(itemColumns).from(canonicalAgentItems)
        .where(sql`(${canonicalAgentItems.createdAt}, ${canonicalAgentItems.id}) > (${state.lastSourceCreatedAt}, ${state.lastSourceId})`)
        .orderBy(asc(canonicalAgentItems.createdAt), asc(canonicalAgentItems.id))
        .limit(MATERIALIZATION_BATCH_ITEMS)
        .all()
      : this.orm.select(itemColumns).from(canonicalAgentItems)
        .orderBy(asc(canonicalAgentItems.createdAt), asc(canonicalAgentItems.id))
        .limit(MATERIALIZATION_BATCH_ITEMS)
        .all();
    let byteLength = 0;
    const bounded: CanonicalItemRow[] = [];
    for (const row of rows) {
      const itemBytes = Buffer.byteLength(row.payloadJson, "utf8");
      if (bounded.length > 0 && byteLength + itemBytes > MATERIALIZATION_BATCH_BYTES) break;
      bounded.push(row);
      byteLength += itemBytes;
    }
    return bounded;
  }

  private materializeRow(row: CanonicalItemRow, resolver?: NarrativeDisplayResolver): void {
    const payload = parsePayload(row);
    const target = this.materializePayload(row, payload, resolver);
    if (!target) return;
    this.mapSource.run({
      sourceItemId: row.id,
      targetKind: target.kind,
      targetId: target.id,
      sourceUpdatedAt: row.updatedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  private materializePayload(
    row: CanonicalItemRow,
    payload: NarrativePayload,
    resolver?: NarrativeDisplayResolver,
  ): { kind: string; id: string } | null {
    switch (payload.projection) {
      case "message": return this.materializeMessagePayload(row, payload.message);
      case "toolCall": return this.materializeDirectNarrative(row, payload, "toolCall", resolver);
      case "narrationSegment": return this.materializeDirectNarrative(row, payload, "narrationSegment", resolver);
      case "hook": return this.materializeDirectNarrative(row, payload, "hook", resolver);
      case "narrativeRecovery": return this.materializeRecoveryPayload(row, payload.narrative, resolver);
      case "codexChildReasoning": return this.materializeChildReasoning(row, payload, resolver);
      case "codexChildToolCall":
      case "codexChildToolResult": return this.materializeChildTool(row, payload, resolver);
      default: return null;
    }
  }

  private materializeRecoveryPayload(
    row: CanonicalItemRow,
    narrative: NarrativePayload["narrative"],
    resolver?: NarrativeDisplayResolver,
  ): { kind: string; id: string } | null {
    return narrative?.record ? this.materializeRecoveryNarrative(row, narrative, resolver) : null;
  }

  private materializeMessagePayload(
    row: CanonicalItemRow,
    message: Message | undefined,
  ): { kind: string; id: string } | null {
    if (!message || !this.isDisplayableMessage(row, message)) return null;
    this.materializeMessage(message);
    if (message.role === "assistant") this.reanchorTurnChildren(row);
    return { kind: "message", id: message.id };
  }

  private materializeDirectNarrative(
    row: CanonicalItemRow,
    payload: NarrativePayload,
    kind: "toolCall" | "narrationSegment" | "hook",
    resolver?: NarrativeDisplayResolver,
  ): { kind: string; id: string } | null {
    if (!payload.record) return null;
    const record = this.withDisplayMessage(payload.record, row, resolver);
    return record ? this.materializeNarrativeRecord(kind, record) : null;
  }

  private materializeNarrativeRecord(
    kind: "toolCall" | "narrationSegment" | "hook",
    record: Record<string, unknown>,
  ): { kind: string; id: string } {
    switch (kind) {
      case "toolCall":
        this.materializeTool(record);
        return { kind, id: requiredString(record.id, "toolCall id") };
      case "narrationSegment":
        this.materializeThought(record);
        return { kind, id: requiredString(record.id, "narrationSegment id") };
      case "hook":
        this.materializeHook(record);
        return { kind, id: requiredString(record.id, "hook id") };
    }
  }

  private materializeRecoveryNarrative(
    row: CanonicalItemRow,
    narrative: { kind?: string; record?: Record<string, unknown> },
    resolver?: NarrativeDisplayResolver,
  ): { kind: string; id: string } | null {
    const record = { ...narrative.record! };
    requiredString(record.id, "recovery narrative id");
    let visibleRecord: Record<string, unknown> | null;
    if (typeof record.message_id !== "string" || record.message_id.length === 0) {
      // Recovery snapshots intentionally omit a staged assistant message. Keep
      // their visible rows on the prompt until a terminal assistant can own them.
      const anchor = resolver ? resolver.recoveryAnchor() : this.recoveryAnchor(row);
      if (!anchor) return null;
      record.message_id = anchor;
      visibleRecord = record;
    } else {
      visibleRecord = this.withDisplayMessage(record, row, resolver);
    }
    if (!visibleRecord) return null;
    return narrative.kind === "toolCall" || narrative.kind === "narrationSegment" || narrative.kind === "hook"
      ? this.materializeNarrativeRecord(narrative.kind, visibleRecord)
      : null;
  }

  private materializeMessage(message: Message): void {
    const origin = message.legacyProvenance ? "legacy" : "canonical";
    this.insertMessage.run({
      id: message.id,
      threadId: message.thread_id,
      role: message.role,
      content: message.content,
      toolCalls: jsonValue(message.tool_calls),
      filesChanged: jsonValue(message.files_changed),
      costUsd: message.cost_usd,
      tokensUsed: message.tokens_used,
      timestamp: message.timestamp,
      sequence: message.sequence,
      attachments: jsonValue(message.attachments),
      previewAnnotations: jsonValue(message.previewAnnotations),
      mentions: jsonValue(message.mentions),
      selectedTextComments: jsonValue(message.selectedTextComments),
      replyToMessageId: message.reply_to_message_id ?? null,
      quotedText: message.quoted_text ?? null,
      model: message.model ?? null,
      originType: origin,
      sourceThreadId: null,
      sourceTurnId: null,
      sourceProviderId: null,
      legacyProvenance: jsonValue(message.legacyProvenance),
      parentAgentProvenance: jsonValue(message.parentAgentProvenance),
      isInternal: message.is_internal ? 1 : 0,
      outcome: message.outcome ?? null,
      outcomeExecutionId: message.outcomeExecutionId ?? null,
      systemNotice: jsonValue(message.systemNotice),
    });
  }

  private materializeTool(record: Record<string, unknown>): void {
    const id = requiredString(record.id, "toolCall id");
    const outputSummary = stringValue(record.output_summary);
    const outputStartsWithBom = outputSummary.startsWith("\uFEFF");
    this.insertTool.run({
      id,
      messageId: requiredString(record.message_id, "toolCall message_id"),
      parentToolCallId: nullableString(record.parent_tool_call_id),
      toolName: requiredString(record.tool_name, "toolCall tool_name"),
      displayName: nullableString(record.display_name),
      providerAgentKey: nullableString(record.provider_agent_key),
      subagentIdentityKey: nullableString(record.subagent_identity_key),
      subagentProviderName: nullableString(record.subagent_provider_name),
      subagentPrompt: nullableString(record.subagent_prompt),
      subagentType: nullableString(record.subagent_type),
      subagentAgentId: nullableString(record.subagent_agent_id),
      subagentDurationMs: nullableNumber(record.subagent_duration_ms),
      model: nullableString(record.model),
      reasoningEffort: nullableString(record.reasoning_effort),
      inputSummary: stringValue(record.input_summary),
      outputStartsWithBom: outputStartsWithBom ? 1 : 0,
      outputSummaryTail: outputStartsWithBom ? outputSummary.slice(1) : "",
      outputSummary,
      outputTruncated: numberValue(record.output_truncated),
      outputTotalBytes: nullableNumber(record.output_total_bytes),
      outputArtifactPath: nullableString(record.output_artifact_path),
      exitCode: nullableNumber(record.exit_code),
      status: requiredString(record.status, "toolCall status"),
      startedAt: requiredString(record.started_at, "toolCall started_at"),
      completedAt: nullableString(record.completed_at),
      sortOrder: numberValue(record.sort_order),
    });
  }

  private materializeThought(record: Record<string, unknown>): void {
    this.insertThought.run({
      id: requiredString(record.id, "thought id"),
      messageId: requiredString(record.message_id, "thought message_id"),
      text: stringValue(record.text),
      startedAt: requiredString(record.started_at, "thought started_at"),
      endedAt: nullableString(record.ended_at),
      sortOrder: numberValue(record.sort_order),
      isFinalResponse: numberValue(record.is_final_response),
    });
  }

  private materializeHook(record: Record<string, unknown>): void {
    this.insertHook.run({
      id: requiredString(record.id, "hook id"),
      messageId: requiredString(record.message_id, "hook message_id"),
      hookName: requiredString(record.hook_name, "hook hook_name"),
      toolName: nullableString(record.tool_name),
      phase: requiredString(record.phase, "hook phase"),
      payload: stringValue(record.payload, "{}"),
      durationMs: nullableNumber(record.duration_ms),
      didBlock: record.did_block === true ? 1 : 0,
      startedAt: requiredString(record.started_at, "hook started_at"),
      endedAt: nullableString(record.ended_at),
      sortOrder: numberValue(record.sort_order),
    });
  }

  private materializeChildReasoning(
    row: CanonicalItemRow,
    payload: NarrativePayload,
    resolver?: NarrativeDisplayResolver,
  ): { kind: string; id: string } | null {
    const messageId = resolver ? resolver.childAnchor() : this.childAnchor(row);
    if (!messageId) return null;
    const id = `codex-child-reasoning:${hashCodexKey(`${payload.nativeItemId ?? row.payloadJson}:${row.id}`)}`;
    const existing = this.orm.select({ sortOrder: thoughtSegments.sortOrder })
      .from(thoughtSegments)
      .where(eq(thoughtSegments.id, id))
      .get();
    const sortOrder = existing?.sortOrder ?? this.nextChildThoughtSortOrder(messageId);
    this.insertThought.run({
      id,
      messageId,
      text: typeof payload.content === "string" ? payload.content : "",
      startedAt: row.createdAt,
      endedAt: row.updatedAt,
      sortOrder,
      isFinalResponse: 0,
    });
    return { kind: "narrationSegment", id };
  }

  private materializeChildTool(
    row: CanonicalItemRow,
    payload: NarrativePayload,
    resolver?: NarrativeDisplayResolver,
  ): { kind: string; id: string } | null {
    const messageId = resolver ? resolver.childAnchor() : this.childAnchor(row);
    if (!messageId) return null;
    const nativeItemId = payload.nativeItemId ?? row.payloadJson;
    const id = `codex-child-tool:${hashCodexKey(nativeItemId)}`;
    const existing = this.orm.select({
      id: toolCallRecords.id,
      toolName: toolCallRecords.toolName,
      inputSummary: toolCallRecords.inputSummary,
      outputSummary: toolCallRecords.outputSummary,
      status: toolCallRecords.status,
      startedAt: toolCallRecords.startedAt,
      completedAt: toolCallRecords.completedAt,
      sortOrder: toolCallRecords.sortOrder,
    }).from(toolCallRecords)
      .where(eq(toolCallRecords.id, id))
      .get() as DisplayToolRecord | undefined;
    const sortOrder = existing?.sortOrder ?? this.nextChildToolSortOrder(messageId);
    const record = this.childToolRecord(id, messageId, row, payload, existing, sortOrder);
    this.materializeTool(record);
    return { kind: "toolCall", id };
  }

  private childToolRecord(
    id: string,
    messageId: string,
    row: CanonicalItemRow,
    payload: NarrativePayload,
    existing: DisplayToolRecord | undefined,
    sortOrder: number,
  ): Record<string, unknown> {
    const isResult = payload.projection === "codexChildToolResult";
    return {
      id,
      message_id: messageId,
      parent_tool_call_id: null,
      tool_name: this.childToolName(payload, existing, isResult),
      input_summary: this.childToolInput(payload, existing, isResult),
      output_summary: this.childToolOutput(payload, existing, isResult),
      status: this.childToolStatus(payload, existing, isResult),
      started_at: existing?.startedAt ?? row.createdAt,
      completed_at: isResult ? row.updatedAt : existing?.completedAt ?? null,
      sort_order: sortOrder,
    };
  }

  private childToolName(payload: NarrativePayload, existing: DisplayToolRecord | undefined, isResult: boolean): string {
    if (isResult) return existing?.toolName ?? "Tool";
    return typeof payload.toolName === "string" ? payload.toolName : "Tool";
  }

  private childToolInput(payload: NarrativePayload, existing: DisplayToolRecord | undefined, isResult: boolean): string {
    return isResult ? existing?.inputSummary ?? "" : formatToolInput(payload.toolInput);
  }

  private childToolOutput(payload: NarrativePayload, existing: DisplayToolRecord | undefined, isResult: boolean): string {
    if (!isResult) return existing?.outputSummary ?? "";
    return typeof payload.output === "string" ? payload.output : "";
  }

  private childToolStatus(payload: NarrativePayload, existing: DisplayToolRecord | undefined, isResult: boolean): string {
    if (!isResult) return existing?.status ?? "running";
    return payload.isError === true ? "failed" : "completed";
  }

  private childAnchor(row: CanonicalItemRow): string | null {
    const childMessage = this.findChildMessage.get({ threadId: row.threadId, turnId: row.turnId });
    // Historical child events may be complete while their provider never
    // emitted a visible message. They have no display projection yet, but the
    // canonical row remains intact and a later terminal message reanchors it.
    if (!childMessage) return null;
    const payload = parsePayload(childMessage);
    if (!payload.message) throw new Error(`Canonical child anchor ${childMessage.id} has no message payload`);
    this.materializeMessage(payload.message);
    return payload.message.id;
  }

  private buildFindChildMessage() {
    return this.orm.select({
      id: canonicalAgentItems.id,
      threadId: canonicalAgentItems.threadId,
      turnId: canonicalAgentItems.turnId,
      payloadJson: canonicalAgentItems.payloadJson,
      createdAt: canonicalAgentItems.createdAt,
      updatedAt: canonicalAgentItems.updatedAt,
    }).from(canonicalAgentItems)
      .where(and(
        eq(canonicalAgentItems.threadId, placeholder("threadId")),
        eq(canonicalAgentItems.turnId, placeholder("turnId")),
        eq(canonicalAgentItems.kind, "message"),
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.projection') = 'message'`,
        sql`COALESCE(json_extract(${canonicalAgentItems.payloadJson}, '$.message.is_internal'), 0) = 0`,
        or(
          sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.role') <> 'assistant'`,
          sql`EXISTS (
            SELECT 1 FROM canonical_agent_ingest_checkpoints checkpoint
            WHERE checkpoint.turn_id = ${canonicalAgentItems.turnId}
              AND checkpoint.terminal_outcome IS NOT NULL
          )`,
        ),
      ))
      .orderBy(
        sql`CASE WHEN json_extract(${canonicalAgentItems.payloadJson}, '$.message.role') = 'assistant' THEN 0 ELSE 1 END`,
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.sequence') ASC`,
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.id') ASC`,
      )
      .limit(1)
      .prepare();
  }

  private withDisplayMessage(
    record: Record<string, unknown>,
    row: CanonicalItemRow,
    resolver?: NarrativeDisplayResolver,
  ): Record<string, unknown> | null {
    const messageId = resolver
      ? resolver.displayMessageId(record.message_id, row)
      : this.displayMessageId(record.message_id, row);
    return messageId ? { ...record, message_id: messageId } : null;
  }

  private displayMessageId(value: unknown, row: CanonicalItemRow): string | null {
    const messageId = requiredString(value, "narrative message_id");
    const exists = this.findDisplayMessage.get({ messageId });
    const source = this.findCanonicalMessage.get({ threadId: row.threadId, messageId });
    if (!source) {
      if (exists) return messageId;
      throw new Error(`Canonical narrative item ${row.id} references missing message ${messageId}`);
    }
    const payload = parsePayload(source);
    if (!payload.message) throw new Error(`Canonical message item ${source.id} has no message payload`);
    if (this.isDisplayableMessage(source, payload.message)) {
      this.materializeMessage(payload.message);
      return messageId;
    }
    if (payload.message.role === "assistant") return this.childAnchor(row);
    throw new Error(`Canonical narrative item ${row.id} references a hidden message ${messageId}`);
  }

  private buildFindDisplayMessage() {
    return this.orm.select({ id: messages.id }).from(messages)
      .where(eq(messages.id, placeholder("messageId")))
      .prepare();
  }

  private buildFindCanonicalMessage() {
    return this.orm.select({
      id: canonicalAgentItems.id,
      threadId: canonicalAgentItems.threadId,
      turnId: canonicalAgentItems.turnId,
      payloadJson: canonicalAgentItems.payloadJson,
      createdAt: canonicalAgentItems.createdAt,
      updatedAt: canonicalAgentItems.updatedAt,
    }).from(canonicalAgentItems)
      .where(and(
        eq(canonicalAgentItems.threadId, placeholder("threadId")),
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.projection') = 'message'`,
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.message.id') = ${placeholder("messageId")}`,
      ))
      .limit(1)
      .prepare();
  }

  private nextChildThoughtSortOrder(messageId: string): number {
    return this.orm.select({ count: count() }).from(thoughtSegments)
      .where(and(
        eq(thoughtSegments.messageId, messageId),
        like(thoughtSegments.id, "codex-child-reasoning:%"),
      ))
      .get()?.count ?? 0;
  }

  private nextChildToolSortOrder(messageId: string): number {
    return this.orm.select({ count: count() }).from(toolCallRecords)
      .where(and(
        eq(toolCallRecords.messageId, messageId),
        like(toolCallRecords.id, "codex-child-tool:%"),
      ))
      .get()?.count ?? 0;
  }

  private isDisplayableMessage(row: CanonicalItemRow, message: Message): boolean {
    if (message.is_internal) return false;
    if (message.role !== "assistant") return true;
    return this.turnHasTerminalCheckpoint(row.turnId);
  }

  private turnHasTerminalCheckpoint(turnId: string): boolean {
    return this.findTerminalCheckpoint.get({ turnId }) != null;
  }

  private buildFindTerminalCheckpoint() {
    return this.orm.select({ executionId: canonicalAgentIngestCheckpoints.executionId })
      .from(canonicalAgentIngestCheckpoints)
      .where(and(
        eq(canonicalAgentIngestCheckpoints.turnId, placeholder("turnId")),
        isNotNull(canonicalAgentIngestCheckpoints.terminalOutcome),
      ))
      .limit(1)
      .prepare();
  }

  private reanchorTurnChildren(row: CanonicalItemRow): void {
    if (!this.turnHasTerminalCheckpoint(row.turnId)) return;
    const children = this.orm.select({
      id: canonicalAgentItems.id,
      threadId: canonicalAgentItems.threadId,
      turnId: canonicalAgentItems.turnId,
      payloadJson: canonicalAgentItems.payloadJson,
      createdAt: canonicalAgentItems.createdAt,
      updatedAt: canonicalAgentItems.updatedAt,
    }).from(canonicalAgentItems)
      .where(and(
        eq(canonicalAgentItems.threadId, row.threadId),
        eq(canonicalAgentItems.turnId, row.turnId),
        sql`json_extract(${canonicalAgentItems.payloadJson}, '$.projection') IN (
          'toolCall', 'narrationSegment', 'hook',
          'codexChildReasoning', 'codexChildToolCall', 'codexChildToolResult', 'narrativeRecovery'
        )`,
      ))
      .orderBy(asc(canonicalAgentItems.createdAt), asc(canonicalAgentItems.id))
      .all();
    const resolver = this.reanchorMessageResolver(row);
    for (const child of children) this.materializeRow(child, resolver);
  }

  private recoveryAnchor(row: CanonicalItemRow): string | null {
    const anchor = this.childAnchor(row);
    return anchor ? this.displayMessageId(anchor, row) : null;
  }

  private reanchorMessageResolver(row: CanonicalItemRow): NarrativeDisplayResolver {
    // Resolution also updates the display message. Only consecutive identical
    // lookups can skip that write when canonical sources share a message ID.
    let previous: { key: string; messageId: string | null } | undefined;
    const resolve = (key: string, read: () => string | null): string | null => {
      if (previous?.key === key) return previous.messageId;
      const messageId = read();
      previous = { key, messageId };
      return messageId;
    };
    return {
      childAnchor: () => resolve("child", () => this.childAnchor(row)),
      recoveryAnchor: () => resolve("recovery", () => this.recoveryAnchor(row)),
      displayMessageId: (value, child) => {
        const messageId = requiredString(value, "narrative message_id");
        return resolve(`message:${messageId}`, () => this.displayMessageId(messageId, child));
      },
    };
  }
}

function displayTableFor(
  kind: string,
): typeof messages | typeof toolCallRecords | typeof thoughtSegments | typeof hookExecutions | null {
  if (kind === "message") return messages;
  if (kind === "toolCall") return toolCallRecords;
  if (kind === "narrationSegment") return thoughtSegments;
  if (kind === "hook") return hookExecutions;
  return null;
}

function parsePayload(row: CanonicalItemRow): NarrativePayload {
  try {
    const payload = JSON.parse(row.payloadJson) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload must be an object");
    }
    return payload as NarrativePayload;
  } catch (error) {
    throw new Error(`Canonical item ${row.id} has invalid payload: ${String(error)}`);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Canonical ${name} is required`);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function jsonValue(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function hashCodexKey(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function formatToolInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
