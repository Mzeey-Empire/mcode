import { writeNarrativeBatch } from "../../conversation/narrative/persistence/narrative-write-batches.js";
/**
 * Tool call record data access layer.
 * Provides creation and retrieval operations for tool call records in SQLite.
 */

import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNull, placeholder, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { ToolCallRecord, ToolCallStatus } from "@mcode/contracts/models/tool-call-record";
import {
  type WriteBatchLimits,
  type WriteBatchResult,
} from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";
import { toolCallRecords } from "../../../../runtime/persistence/sqlite/schema.js";

/** Row shape returned by drizzle for the tool_call_records table. */
type ToolCallRecordRow = typeof toolCallRecords.$inferSelect;

/** Input for creating a new tool call record. */
export interface CreateToolCallRecordInput {
  /** Original tool call ID from the provider SDK. Preserves parent-child linkage. */
  toolCallId?: string;
  messageId: string;
  toolName: string;
  displayName?: string;
  providerAgentKey?: string;
  subagentIdentityKey?: string;
  subagentProviderName?: string;
  subagentPrompt?: string;
  subagentType?: string;
  subagentAgentId?: string;
  subagentDurationMs?: number;
  model?: string;
  reasoningEffort?: string;
  inputSummary: string;
  outputSummary: string;
  outputTruncated?: boolean;
  outputTotalBytes?: number;
  outputArtifactPath?: string;
  exitCode?: number;
  status: ToolCallStatus;
  /** ISO timestamp captured when the provider started the tool call. */
  startedAt?: string;
  /** ISO timestamp captured when the tool call reached a terminal status. */
  completedAt?: string;
  sortOrder: number;
  parentToolCallId?: string;
  /** True when the provider keeps this call running after its turn ends. */
  background?: boolean;
}

interface ToolCallRecordInsert {
  id: string;
  startedAt: string;
  completedAt: string | null;
}

function nullIfUndefined<T>(value: T | undefined): T | null {
  return value ?? null;
}

function sqliteBoolean(value: boolean | undefined): number {
  return value === true ? 1 : 0;
}

function prepareToolCallRecordInsert(
  input: CreateToolCallRecordInput,
  now: string,
): ToolCallRecordInsert {
  const id = input.toolCallId ?? NodeCrypto.randomUUID();
  const startedAt = input.startedAt ?? now;
  const completedAt = input.status !== "running" ? input.completedAt ?? now : null;
  return { id, startedAt, completedAt };
}

function toolCallRecordFromInsert(
  input: CreateToolCallRecordInput,
  insert: ToolCallRecordInsert,
): ToolCallRecord {
  return {
    id: insert.id,
    message_id: input.messageId,
    parent_tool_call_id: nullIfUndefined(input.parentToolCallId),
    tool_name: input.toolName,
    display_name: nullIfUndefined(input.displayName),
    provider_agent_key: nullIfUndefined(input.providerAgentKey),
    subagent_identity_key: nullIfUndefined(input.subagentIdentityKey),
    subagent_provider_name: nullIfUndefined(input.subagentProviderName),
    subagent_prompt: nullIfUndefined(input.subagentPrompt),
    subagent_type: nullIfUndefined(input.subagentType),
    subagent_agent_id: nullIfUndefined(input.subagentAgentId),
    subagent_duration_ms: nullIfUndefined(input.subagentDurationMs),
    model: nullIfUndefined(input.model),
    reasoning_effort: nullIfUndefined(input.reasoningEffort),
    input_summary: input.inputSummary,
    output_summary: input.outputSummary,
    output_truncated: sqliteBoolean(input.outputTruncated),
    output_total_bytes: nullIfUndefined(input.outputTotalBytes),
    output_artifact_path: nullIfUndefined(input.outputArtifactPath),
    exit_code: nullIfUndefined(input.exitCode),
    status: input.status,
    ...(input.background === true ? { background: true } : {}),
    started_at: insert.startedAt,
    completed_at: insert.completedAt,
    sort_order: input.sortOrder,
  };
}

function rowToToolCallRecord(row: ToolCallRecordRow): ToolCallRecord {
  return {
    id: row.id,
    message_id: row.messageId,
    parent_tool_call_id: row.parentToolCallId,
    tool_name: row.toolName,
    display_name: row.displayName,
    provider_agent_key: row.providerAgentKey,
    subagent_identity_key: row.subagentIdentityKey,
    subagent_provider_name: row.subagentProviderName,
    subagent_prompt: row.subagentPrompt,
    subagent_type: row.subagentType,
    subagent_agent_id: row.subagentAgentId,
    subagent_duration_ms: row.subagentDurationMs,
    model: row.model,
    reasoning_effort: row.reasoningEffort,
    input_summary: row.inputSummary,
    output_summary: row.outputSummary,
    output_truncated: row.outputTruncated,
    output_total_bytes: row.outputTotalBytes,
    output_artifact_path: row.outputArtifactPath,
    exit_code: row.exitCode,
    status: row.status as ToolCallStatus,
    ...(row.background ? { background: true } : {}),
    started_at: row.startedAt,
    completed_at: row.completedAt,
    sort_order: row.sortOrder,
  };
}

/** Repository for tool call record creation and retrieval against SQLite. */
export class ToolCallRecordStore {
  private readonly orm: BunSQLiteDatabase;
  private readonly insertStatement: ReturnType<ToolCallRecordStore["buildInsertStatement"]>;
  private readonly replaceStatement: ReturnType<ToolCallRecordStore["buildInsertStatement"]>;

  constructor(db: Database) {
    this.orm = drizzle(db);
    this.insertStatement = this.buildInsertStatement(false);
    this.replaceStatement = this.buildInsertStatement(true);
  }

  /** Create a new tool call record and return the fully-populated record. */
  create(input: CreateToolCallRecordInput): ToolCallRecord {
    const now = new Date().toISOString();
    const insert = prepareToolCallRecordInsert(input, now);
    this.write(input, insert);
    return toolCallRecordFromInsert(input, insert);
  }

  /** Create multiple tool call records in a single transaction. */
  bulkCreate(inputs: CreateToolCallRecordInput[], replaceExisting = false): void {
    this.orm.transaction(() => {
      const now = new Date().toISOString();
      for (const item of inputs) {
        const insert = prepareToolCallRecordInsert(item, now);
        this.writePrepared(item, insert, replaceExisting);
      }
    });
  }
  /** Commit one bounded prefix inside the owner transaction. */
  createBoundedBatch(inputs: readonly CreateToolCallRecordInput[], limits: WriteBatchLimits, replaceExisting: boolean): WriteBatchResult {
    return writeNarrativeBatch(inputs, limits, item => {
      const insert = prepareToolCallRecordInsert(item, new Date().toISOString());
      this.writePrepared(item, insert, replaceExisting);
    });
  }

  private buildInsertStatement(replaceExisting: boolean) {
    const write = this.orm.insert(toolCallRecords).values({
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
      outputSummary: placeholder("outputSummary"),
      outputTruncated: placeholder("outputTruncated"),
      outputTotalBytes: placeholder("outputTotalBytes"),
      outputArtifactPath: placeholder("outputArtifactPath"),
      exitCode: placeholder("exitCode"),
      status: placeholder("status"),
      background: placeholder("background"),
      startedAt: placeholder("startedAt"),
      completedAt: placeholder("completedAt"),
      sortOrder: placeholder("sortOrder"),
    });
    if (!replaceExisting) return write.onConflictDoNothing().prepare();
    return write.onConflictDoUpdate({
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
        background: sql`excluded.background`,
        startedAt: sql`excluded.started_at`,
        completedAt: sql`excluded.completed_at`,
        sortOrder: sql`excluded.sort_order`,
      },
    }).prepare();
  }

  private writePrepared(input: CreateToolCallRecordInput, insert: ToolCallRecordInsert, replaceExisting: boolean): void {
    const statement = replaceExisting ? this.replaceStatement : this.insertStatement;
    statement.run(this.insertValues(input, insert));
  }

  private insertValues(
    input: CreateToolCallRecordInput,
    insert: ToolCallRecordInsert,
  ) {
    return {
      id: insert.id,
      messageId: input.messageId,
      parentToolCallId: nullIfUndefined(input.parentToolCallId),
      toolName: input.toolName,
      displayName: nullIfUndefined(input.displayName),
      providerAgentKey: nullIfUndefined(input.providerAgentKey),
      subagentIdentityKey: nullIfUndefined(input.subagentIdentityKey),
      subagentProviderName: nullIfUndefined(input.subagentProviderName),
      subagentPrompt: nullIfUndefined(input.subagentPrompt),
      subagentType: nullIfUndefined(input.subagentType),
      subagentAgentId: nullIfUndefined(input.subagentAgentId),
      subagentDurationMs: nullIfUndefined(input.subagentDurationMs),
      model: nullIfUndefined(input.model),
      reasoningEffort: nullIfUndefined(input.reasoningEffort),
      inputSummary: input.inputSummary,
      outputSummary: input.outputSummary,
      outputTruncated: sqliteBoolean(input.outputTruncated),
      outputTotalBytes: nullIfUndefined(input.outputTotalBytes),
      outputArtifactPath: nullIfUndefined(input.outputArtifactPath),
      exitCode: nullIfUndefined(input.exitCode),
      status: input.status,
      background: input.background === true,
      startedAt: insert.startedAt,
      completedAt: insert.completedAt,
      sortOrder: input.sortOrder,
    };
  }

  private write(
    input: CreateToolCallRecordInput,
    insert: ToolCallRecordInsert,
    replaceExisting = false,
  ): void {
    const { id, ...rest } = this.insertValues(input, insert);
    const builder = this.orm.insert(toolCallRecords).values({ id, ...rest });
    if (replaceExisting) {
      builder
        .onConflictDoUpdate({ target: toolCallRecords.id, set: rest })
        .run();
    } else {
      builder.onConflictDoNothing().run();
    }
  }

  /** List all tool call records for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): ToolCallRecord[] {
    const rows = this.orm
      .select()
      .from(toolCallRecords)
      .where(eq(toolCallRecords.messageId, messageId))
      .orderBy(asc(toolCallRecords.sortOrder))
      .all();
    return rows.map(rowToToolCallRecord);
  }

  /** Backfill an exact sub-agent identity on a row persisted before provider enrichment arrived. */
  updateSubagentIdentity(
    toolCallId: string,
    messageId: string,
    subagentIdentityKey: string,
  ): boolean {
    const result = runChanges(
      this.orm
        .update(toolCallRecords)
        .set({ subagentIdentityKey })
        .where(
          and(
            eq(toolCallRecords.id, toolCallId),
            eq(toolCallRecords.messageId, messageId),
            isNull(toolCallRecords.subagentIdentityKey),
          ),
        ),
    );
    return result.changes > 0;
  }

  /** List tool call records for many messages in one indexed query, grouped by message id. */
  listByMessages(messageIds: readonly string[]): Map<string, ToolCallRecord[]> {
    const grouped = new Map<string, ToolCallRecord[]>();
    if (messageIds.length === 0) return grouped;

    const rows = this.orm
      .select()
      .from(toolCallRecords)
      .where(inArray(toolCallRecords.messageId, [...messageIds]))
      .orderBy(asc(toolCallRecords.messageId), asc(toolCallRecords.sortOrder))
      .all();

    for (const row of rows) {
      const record = rowToToolCallRecord(row);
      const list = grouped.get(record.message_id) ?? [];
      list.push(record);
      grouped.set(record.message_id, list);
    }
    return grouped;
  }

  /** List child tool call records for a parent, ordered by sort_order ascending. */
  listByParent(parentToolCallId: string): ToolCallRecord[] {
    const rows = this.orm
      .select()
      .from(toolCallRecords)
      .where(eq(toolCallRecords.parentToolCallId, parentToolCallId))
      .orderBy(asc(toolCallRecords.sortOrder))
      .all();
    return rows.map(rowToToolCallRecord);
  }

  /** Count the number of tool call records for a message. */
  countByMessage(messageId: string): number {
    const row = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(toolCallRecords)
      .where(eq(toolCallRecords.messageId, messageId))
      .get();
    return row?.count ?? 0;
  }
}
