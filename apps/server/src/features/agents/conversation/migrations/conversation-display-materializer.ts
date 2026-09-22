import * as NodeCrypto from "node:crypto";
import type { Database, Statement } from "bun:sqlite";
import type { Message } from "@mcode/contracts";

const MATERIALIZATION_STATE_ID = 1;
const MATERIALIZATION_BATCH_ITEMS = 100;
const MATERIALIZATION_BATCH_BYTES = 1_048_576;

interface CanonicalItemRow {
  id: string;
  thread_id: string;
  turn_id: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
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
  tool_name: string;
  input_summary: string;
  output_summary: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  sort_order: number;
}

/**
 * Writes display-table projections for canonical conversation items before the
 * server admits provider work. The mapping stores identities only, so canonical
 * provenance remains the single durable source for materialized rows.
 */
export class ConversationDisplayMaterializer {
  private readonly insertMessage: Statement;
  private readonly insertTool: Statement;
  private readonly insertThought: Statement;
  private readonly insertHook: Statement;
  private readonly mapSource: Statement;

  constructor(private readonly db: Database) {
    this.insertMessage = db.prepare(`
      INSERT INTO messages (
        id, thread_id, role, content, tool_calls, files_changed, cost_usd,
        tokens_used, timestamp, sequence, attachments, preview_annotations,
        mentions, selected_text_comments, reply_to_message_id, quoted_text,
        model, origin_type, source_thread_id, source_turn_id, source_provider_id,
        legacy_provenance, parent_agent_provenance, is_internal, outcome, outcome_execution_id, system_notice
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        tool_calls = excluded.tool_calls,
        files_changed = excluded.files_changed,
        cost_usd = excluded.cost_usd,
        tokens_used = excluded.tokens_used,
        timestamp = excluded.timestamp,
        sequence = excluded.sequence,
        attachments = excluded.attachments,
        preview_annotations = excluded.preview_annotations,
        mentions = excluded.mentions,
        selected_text_comments = COALESCE(excluded.selected_text_comments, messages.selected_text_comments),
        reply_to_message_id = excluded.reply_to_message_id,
        quoted_text = excluded.quoted_text,
        model = excluded.model,
        origin_type = CASE
          WHEN excluded.origin_type = 'canonical' AND messages.origin_type <> 'canonical'
            THEN messages.origin_type
          ELSE excluded.origin_type
        END,
        source_thread_id = COALESCE(excluded.source_thread_id, messages.source_thread_id),
        source_turn_id = COALESCE(excluded.source_turn_id, messages.source_turn_id),
        source_provider_id = COALESCE(excluded.source_provider_id, messages.source_provider_id),
        legacy_provenance = COALESCE(excluded.legacy_provenance, messages.legacy_provenance),
        is_internal = excluded.is_internal,
        parent_agent_provenance = COALESCE(excluded.parent_agent_provenance, messages.parent_agent_provenance),
        outcome = COALESCE(excluded.outcome, messages.outcome),
        outcome_execution_id = COALESCE(excluded.outcome_execution_id, messages.outcome_execution_id),
        system_notice = COALESCE(excluded.system_notice, messages.system_notice)
    `);
    this.insertTool = db.prepare(`
      INSERT INTO tool_call_records (
        id, message_id, parent_tool_call_id, tool_name, display_name,
        provider_agent_key, subagent_identity_key, subagent_provider_name,
        subagent_prompt, subagent_type, subagent_agent_id, subagent_duration_ms,
        model, reasoning_effort, input_summary, output_summary, output_truncated,
        output_total_bytes, output_artifact_path, exit_code, status, started_at,
        completed_at, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? THEN char(65279) || ? ELSE ? END, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        message_id = excluded.message_id,
        parent_tool_call_id = excluded.parent_tool_call_id,
        tool_name = excluded.tool_name,
        display_name = excluded.display_name,
        provider_agent_key = excluded.provider_agent_key,
        subagent_identity_key = excluded.subagent_identity_key,
        subagent_provider_name = excluded.subagent_provider_name,
        subagent_prompt = excluded.subagent_prompt,
        subagent_type = excluded.subagent_type,
        subagent_agent_id = excluded.subagent_agent_id,
        subagent_duration_ms = excluded.subagent_duration_ms,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        input_summary = excluded.input_summary,
        output_summary = excluded.output_summary,
        output_truncated = excluded.output_truncated,
        output_total_bytes = excluded.output_total_bytes,
        output_artifact_path = excluded.output_artifact_path,
        exit_code = excluded.exit_code,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        sort_order = excluded.sort_order
    `);
    this.insertThought = db.prepare(`
      INSERT INTO thought_segments (
        id, message_id, text, started_at, ended_at, sort_order, is_final_response
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        message_id = excluded.message_id,
        text = excluded.text,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        sort_order = excluded.sort_order,
        is_final_response = excluded.is_final_response
    `);
    this.insertHook = db.prepare(`
      INSERT INTO hook_executions (
        id, message_id, hook_name, tool_name, phase, payload, duration_ms,
        did_block, started_at, ended_at, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        message_id = excluded.message_id,
        hook_name = excluded.hook_name,
        tool_name = excluded.tool_name,
        phase = excluded.phase,
        payload = excluded.payload,
        duration_ms = excluded.duration_ms,
        did_block = excluded.did_block,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        sort_order = excluded.sort_order
    `);
    this.mapSource = db.prepare(`
      INSERT INTO canonical_conversation_display_mappings (
        source_item_id, target_kind, target_id, source_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_item_id) DO UPDATE SET
        target_kind = excluded.target_kind,
        target_id = excluded.target_id,
        source_updated_at = excluded.source_updated_at,
        updated_at = excluded.updated_at
    `);
  }

  /** Materializes every canonical row in bounded, restart-safe transactions. */
  async runToCompletion(): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO conversation_display_materialization_state (id, completed)
      VALUES (?, 0)
    `).run(MATERIALIZATION_STATE_ID);

    while (true) {
      const batch = this.nextBatch();
      if (batch.length === 0) {
        this.db.prepare(`
          UPDATE conversation_display_materialization_state
          SET completed = 1, updated_at = ?
          WHERE id = ?
        `).run(new Date().toISOString(), MATERIALIZATION_STATE_ID);
        return;
      }
      this.db.transaction(() => {
        for (const row of batch) this.materializeRow(row);
        const last = batch.at(-1)!;
        this.db.prepare(`
          UPDATE conversation_display_materialization_state
          SET last_source_created_at = ?, last_source_id = ?, completed = 0, updated_at = ?
          WHERE id = ?
        `).run(last.created_at, last.id, new Date().toISOString(), MATERIALIZATION_STATE_ID);
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Writes newly persisted canonical items in the caller's existing transaction. */
  materializeItems(itemIds: readonly string[]): void {
    if (itemIds.length === 0) return;
    const rows = this.db.prepare(`
      SELECT id, thread_id, turn_id, payload_json, created_at, updated_at
      FROM canonical_agent_items
      WHERE id IN (${itemIds.map(() => "?").join(", ")})
      ORDER BY created_at ASC, id ASC
    `).all(...itemIds) as CanonicalItemRow[];
    for (const row of rows) this.materializeRow(row);
  }

  /** Removes a discarded canonical recovery projection and its orphaned display row. */
  discardItem(itemId: string): void {
    const mapping = this.db.prepare(`
      SELECT target_kind, target_id
      FROM canonical_conversation_display_mappings
      WHERE source_item_id = ?
    `).get(itemId) as { target_kind: string; target_id: string } | undefined;
    if (!mapping) return;
    this.db.prepare("DELETE FROM canonical_conversation_display_mappings WHERE source_item_id = ?").run(itemId);
    const remaining = this.db.prepare(`
      SELECT 1 FROM canonical_conversation_display_mappings
      WHERE target_kind = ? AND target_id = ?
      LIMIT 1
    `).get(mapping.target_kind, mapping.target_id);
    if (remaining) return;
    const table = displayTableFor(mapping.target_kind);
    if (table) this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(mapping.target_id);
  }

  private nextBatch(): CanonicalItemRow[] {
    const state = this.db.prepare(`
      SELECT last_source_created_at, last_source_id
      FROM conversation_display_materialization_state
      WHERE id = ?
    `).get(MATERIALIZATION_STATE_ID) as {
      last_source_created_at: string | null;
      last_source_id: string | null;
    } | undefined;
    const rows = state?.last_source_created_at && state.last_source_id
      ? this.db.prepare(`
        SELECT id, thread_id, turn_id, payload_json, created_at, updated_at
        FROM canonical_agent_items
        WHERE (created_at, id) > (?, ?)
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `).all(state.last_source_created_at, state.last_source_id, MATERIALIZATION_BATCH_ITEMS) as CanonicalItemRow[]
      : this.db.prepare(`
        SELECT id, thread_id, turn_id, payload_json, created_at, updated_at
        FROM canonical_agent_items
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `).all(MATERIALIZATION_BATCH_ITEMS) as CanonicalItemRow[];
    let byteLength = 0;
    const bounded: CanonicalItemRow[] = [];
    for (const row of rows) {
      const itemBytes = Buffer.byteLength(row.payload_json, "utf8");
      if (bounded.length > 0 && byteLength + itemBytes > MATERIALIZATION_BATCH_BYTES) break;
      bounded.push(row);
      byteLength += itemBytes;
    }
    return bounded;
  }

  private materializeRow(row: CanonicalItemRow): void {
    const payload = parsePayload(row);
    const target = this.materializePayload(row, payload);
    if (!target) return;
    this.mapSource.run(row.id, target.kind, target.id, row.updated_at, new Date().toISOString());
  }

  private materializePayload(
    row: CanonicalItemRow,
    payload: NarrativePayload,
  ): { kind: string; id: string } | null {
    switch (payload.projection) {
      case "message": return this.materializeMessagePayload(row, payload.message);
      case "toolCall": return this.materializeDirectNarrative(row, payload, "toolCall");
      case "narrationSegment": return this.materializeDirectNarrative(row, payload, "narrationSegment");
      case "hook": return this.materializeDirectNarrative(row, payload, "hook");
      case "narrativeRecovery": return this.materializeRecoveryPayload(row, payload.narrative);
      case "codexChildReasoning": return this.materializeChildReasoning(row, payload);
      case "codexChildToolCall":
      case "codexChildToolResult": return this.materializeChildTool(row, payload);
      default: return null;
    }
  }

  private materializeRecoveryPayload(
    row: CanonicalItemRow,
    narrative: NarrativePayload["narrative"],
  ): { kind: string; id: string } | null {
    return narrative?.record ? this.materializeRecoveryNarrative(row, narrative) : null;
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
  ): { kind: string; id: string } | null {
    if (!payload.record) return null;
    const record = this.withDisplayMessage(payload.record, row);
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
  ): { kind: string; id: string } | null {
    const record = { ...narrative.record! };
    requiredString(record.id, "recovery narrative id");
    if (typeof record.message_id !== "string" || record.message_id.length === 0) {
      // Recovery snapshots intentionally omit a staged assistant message. Keep
      // their visible rows on the prompt until a terminal assistant can own them.
      const anchor = this.childAnchor(row);
      if (!anchor) return null;
      record.message_id = anchor;
    }
    const visibleRecord = this.withDisplayMessage(record, row);
    if (!visibleRecord) return null;
    return narrative.kind === "toolCall" || narrative.kind === "narrationSegment" || narrative.kind === "hook"
      ? this.materializeNarrativeRecord(narrative.kind, visibleRecord)
      : null;
  }

  private materializeMessage(message: Message): void {
    const origin = message.legacyProvenance ? "legacy" : "canonical";
    this.insertMessage.run(
      message.id, message.thread_id, message.role, message.content,
      jsonValue(message.tool_calls), jsonValue(message.files_changed), message.cost_usd,
      message.tokens_used, message.timestamp, message.sequence, jsonValue(message.attachments),
      jsonValue(message.previewAnnotations), jsonValue(message.mentions), jsonValue(message.selectedTextComments),
      message.reply_to_message_id ?? null, message.quoted_text ?? null, message.model ?? null,
      origin, null, null, null,
      jsonValue(message.legacyProvenance),
      jsonValue(message.parentAgentProvenance),
      message.is_internal ? 1 : 0, message.outcome ?? null, message.outcomeExecutionId ?? null,
      jsonValue(message.systemNotice),
    );
  }

  private materializeTool(record: Record<string, unknown>): void {
    const id = requiredString(record.id, "toolCall id");
    const outputSummary = stringValue(record.output_summary);
    // Bun strips a leading BOM from bound text. The old display table can
    // contain one, so construct that first character inside SQLite.
    const outputStartsWithBom = outputSummary.startsWith("\uFEFF");
    this.insertTool.run(
      id, requiredString(record.message_id, "toolCall message_id"),
      nullableString(record.parent_tool_call_id), requiredString(record.tool_name, "toolCall tool_name"),
      nullableString(record.display_name), nullableString(record.provider_agent_key),
      nullableString(record.subagent_identity_key), nullableString(record.subagent_provider_name),
      nullableString(record.subagent_prompt), nullableString(record.subagent_type),
      nullableString(record.subagent_agent_id), nullableNumber(record.subagent_duration_ms),
      nullableString(record.model), nullableString(record.reasoning_effort),
      stringValue(record.input_summary), outputStartsWithBom ? 1 : 0,
      outputStartsWithBom ? outputSummary.slice(1) : "", outputSummary,
      numberValue(record.output_truncated),
      nullableNumber(record.output_total_bytes), nullableString(record.output_artifact_path),
      nullableNumber(record.exit_code), requiredString(record.status, "toolCall status"),
      requiredString(record.started_at, "toolCall started_at"), nullableString(record.completed_at),
      numberValue(record.sort_order),
    );
  }

  private materializeThought(record: Record<string, unknown>): void {
    const id = requiredString(record.id, "thought id");
    this.insertThought.run(
      id, requiredString(record.message_id, "thought message_id"),
      stringValue(record.text), requiredString(record.started_at, "thought started_at"),
      nullableString(record.ended_at), numberValue(record.sort_order), numberValue(record.is_final_response),
    );
  }

  private materializeHook(record: Record<string, unknown>): void {
    const id = requiredString(record.id, "hook id");
    this.insertHook.run(
      id, requiredString(record.message_id, "hook message_id"),
      requiredString(record.hook_name, "hook hook_name"), nullableString(record.tool_name),
      requiredString(record.phase, "hook phase"), stringValue(record.payload, "{}"),
      nullableNumber(record.duration_ms), record.did_block === true ? 1 : 0,
      requiredString(record.started_at, "hook started_at"), nullableString(record.ended_at),
      numberValue(record.sort_order),
    );
  }

  private materializeChildReasoning(
    row: CanonicalItemRow,
    payload: NarrativePayload,
  ): { kind: string; id: string } | null {
    const messageId = this.childAnchor(row);
    if (!messageId) return null;
    const id = `codex-child-reasoning:${hashCodexKey(`${payload.nativeItemId ?? row.payload_json}:${row.id}`)}`;
    const existing = this.db.prepare("SELECT sort_order FROM thought_segments WHERE id = ?").get(id) as
      | { sort_order: number }
      | undefined;
    const sortOrder = existing?.sort_order ?? this.nextChildThoughtSortOrder(messageId);
    this.insertThought.run(
      id, messageId, typeof payload.content === "string" ? payload.content : "",
      row.created_at, row.updated_at, sortOrder, 0,
    );
    return { kind: "narrationSegment", id };
  }

  private materializeChildTool(
    row: CanonicalItemRow,
    payload: NarrativePayload,
  ): { kind: string; id: string } | null {
    const messageId = this.childAnchor(row);
    if (!messageId) return null;
    const nativeItemId = payload.nativeItemId ?? row.payload_json;
    const id = `codex-child-tool:${hashCodexKey(nativeItemId)}`;
    const existing = this.db.prepare(`
      SELECT id, tool_name, input_summary, output_summary, status, started_at, completed_at, sort_order
      FROM tool_call_records WHERE id = ?
    `).get(id) as DisplayToolRecord | undefined;
    const sortOrder = existing?.sort_order ?? this.nextChildToolSortOrder(messageId);
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
      started_at: existing?.started_at ?? row.created_at,
      completed_at: isResult ? row.updated_at : existing?.completed_at ?? null,
      sort_order: sortOrder,
    };
  }

  private childToolName(payload: NarrativePayload, existing: DisplayToolRecord | undefined, isResult: boolean): string {
    if (isResult) return existing?.tool_name ?? "Tool";
    return typeof payload.toolName === "string" ? payload.toolName : "Tool";
  }

  private childToolInput(payload: NarrativePayload, existing: DisplayToolRecord | undefined, isResult: boolean): string {
    return isResult ? existing?.input_summary ?? "" : formatToolInput(payload.toolInput);
  }

  private childToolOutput(payload: NarrativePayload, existing: DisplayToolRecord | undefined, isResult: boolean): string {
    if (!isResult) return existing?.output_summary ?? "";
    return typeof payload.output === "string" ? payload.output : "";
  }

  private childToolStatus(payload: NarrativePayload, existing: DisplayToolRecord | undefined, isResult: boolean): string {
    if (!isResult) return existing?.status ?? "running";
    return payload.isError === true ? "failed" : "completed";
  }

  private childAnchor(row: CanonicalItemRow): string | null {
    const childMessage = this.db.prepare(`
      SELECT id, thread_id, turn_id, payload_json, created_at, updated_at
      FROM canonical_agent_items
      WHERE thread_id = ? AND turn_id = ? AND kind = 'message'
        AND json_extract(payload_json, '$.projection') = 'message'
        AND COALESCE(json_extract(payload_json, '$.message.is_internal'), 0) = 0
        AND (
          json_extract(payload_json, '$.message.role') <> 'assistant'
          OR EXISTS (
            SELECT 1 FROM canonical_agent_ingest_checkpoints checkpoint
            WHERE checkpoint.turn_id = canonical_agent_items.turn_id
              AND checkpoint.terminal_outcome IS NOT NULL
          )
        )
      ORDER BY CASE WHEN json_extract(payload_json, '$.message.role') = 'assistant' THEN 0 ELSE 1 END,
        json_extract(payload_json, '$.message.sequence') ASC,
        json_extract(payload_json, '$.message.id') ASC
      LIMIT 1
    `).get(row.thread_id, row.turn_id) as CanonicalItemRow | undefined;
    // Historical child events may be complete while their provider never
    // emitted a visible message. They have no display projection yet, but the
    // canonical row remains intact and a later terminal message reanchors it.
    if (!childMessage) return null;
    const payload = parsePayload(childMessage);
    if (!payload.message) throw new Error(`Canonical child anchor ${childMessage.id} has no message payload`);
    this.materializeMessage(payload.message);
    return payload.message.id;
  }

  private withDisplayMessage(
    record: Record<string, unknown>,
    row: CanonicalItemRow,
  ): Record<string, unknown> | null {
    const messageId = this.displayMessageId(record.message_id, row);
    return messageId ? { ...record, message_id: messageId } : null;
  }

  private displayMessageId(value: unknown, row: CanonicalItemRow): string | null {
    const messageId = requiredString(value, "narrative message_id");
    const exists = this.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(messageId);
    const source = this.db.prepare(`
      SELECT id, thread_id, turn_id, payload_json, created_at, updated_at
      FROM canonical_agent_items
      WHERE thread_id = ? AND json_extract(payload_json, '$.projection') = 'message'
        AND json_extract(payload_json, '$.message.id') = ?
      LIMIT 1
    `).get(row.thread_id, messageId) as CanonicalItemRow | undefined;
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

  private nextChildThoughtSortOrder(messageId: string): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM thought_segments
      WHERE message_id = ? AND id LIKE 'codex-child-reasoning:%'
    `).get(messageId) as { count: number }).count;
  }

  private nextChildToolSortOrder(messageId: string): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM tool_call_records
      WHERE message_id = ? AND id LIKE 'codex-child-tool:%'
    `).get(messageId) as { count: number }).count;
  }

  private isDisplayableMessage(row: CanonicalItemRow, message: Message): boolean {
    if (message.is_internal) return false;
    if (message.role !== "assistant") return true;
    return this.turnHasTerminalCheckpoint(row.turn_id);
  }

  private turnHasTerminalCheckpoint(turnId: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM canonical_agent_ingest_checkpoints
      WHERE turn_id = ? AND terminal_outcome IS NOT NULL
      LIMIT 1
    `).get(turnId) != null;
  }

  private reanchorTurnChildren(row: CanonicalItemRow): void {
    if (!this.turnHasTerminalCheckpoint(row.turn_id)) return;
    const children = this.db.prepare(`
      SELECT id, thread_id, turn_id, payload_json, created_at, updated_at
      FROM canonical_agent_items
      WHERE thread_id = ? AND turn_id = ?
        AND json_extract(payload_json, '$.projection') IN (
          'toolCall', 'narrationSegment', 'hook',
          'codexChildReasoning', 'codexChildToolCall', 'codexChildToolResult', 'narrativeRecovery'
        )
      ORDER BY created_at ASC, id ASC
    `).all(row.thread_id, row.turn_id) as CanonicalItemRow[];
    for (const child of children) this.materializeRow(child);
  }
}

function displayTableFor(kind: string): "messages" | "tool_call_records" | "thought_segments" | "hook_executions" | null {
  if (kind === "message") return "messages";
  if (kind === "toolCall") return "tool_call_records";
  if (kind === "narrationSegment") return "thought_segments";
  if (kind === "hook") return "hook_executions";
  return null;
}

function parsePayload(row: CanonicalItemRow): NarrativePayload {
  try {
    const payload = JSON.parse(row.payload_json) as unknown;
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
