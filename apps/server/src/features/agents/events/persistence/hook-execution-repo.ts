/**
 * Hook execution record data access layer.
 * Provides creation and retrieval operations for persisted hook executions.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { HookExecutionRecord } from "@mcode/contracts";
import {
  ACTIVE_TURN_WRITE_BATCH_LIMITS,
  runBoundedWriteBatches,
  type WriteBatchLimits,
  type WriteBatchResult,
} from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { hookExecutions } from "../../../../runtime/persistence/sqlite/schema.js";

/** Row shape returned by drizzle for the hook_executions table. */
type HookExecutionRow = typeof hookExecutions.$inferSelect;

/** Input for creating a new hook execution record. */
export interface CreateHookExecutionInput {
  /** Optional explicit id; generated if omitted. */
  id?: string;
  messageId: string;
  hookName: string;
  toolName: string | null;
  phase: string;
  payload: string;
  durationMs: number | null;
  didBlock: boolean;
  startedAt: string;
  endedAt: string | null;
  sortOrder: number;
}

function rowToRecord(row: HookExecutionRow): HookExecutionRecord {
  return {
    id: row.id,
    message_id: row.messageId,
    hook_name: row.hookName,
    tool_name: row.toolName,
    phase: row.phase,
    payload: row.payload,
    duration_ms: row.durationMs,
    did_block: row.didBlock === 1,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    sort_order: row.sortOrder,
  };
}

/** Repository for hook execution creation and retrieval against SQLite. */
@injectable()
export class HookExecutionRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") private readonly db: Database) {
    this.orm = drizzle(db);
  }

  /** Create a single hook execution record and return the fully-populated record. */
  create(input: CreateHookExecutionInput): HookExecutionRecord {
    const id = input.id ?? NodeCrypto.randomUUID();
    this.orm
      .insert(hookExecutions)
      .values({
        id,
        messageId: input.messageId,
        hookName: input.hookName,
        toolName: input.toolName,
        phase: input.phase,
        payload: input.payload,
        durationMs: input.durationMs,
        didBlock: input.didBlock ? 1 : 0,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        sortOrder: input.sortOrder,
      })
      .onConflictDoNothing()
      .run();
    return {
      id,
      message_id: input.messageId,
      hook_name: input.hookName,
      tool_name: input.toolName,
      phase: input.phase,
      payload: input.payload,
      duration_ms: input.durationMs,
      did_block: input.didBlock,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      sort_order: input.sortOrder,
    };
  }

  /** Insert multiple hook execution records in a single transaction. */
  bulkCreate(inputs: CreateHookExecutionInput[]): void {
    if (inputs.length === 0) return;
    this.orm.transaction((tx) => {
      for (const item of inputs) {
        tx.insert(hookExecutions)
          .values({
            id: item.id ?? NodeCrypto.randomUUID(),
            messageId: item.messageId,
            hookName: item.hookName,
            toolName: item.toolName,
            phase: item.phase,
            payload: item.payload,
            durationMs: item.durationMs,
            didBlock: item.didBlock ? 1 : 0,
            startedAt: item.startedAt,
            endedAt: item.endedAt,
            sortOrder: item.sortOrder,
          })
          .onConflictDoNothing()
          .run();
      }
    });
  }

  /** Insert hook rows in bounded transactions with an event-loop yield between commits. */
  async bulkCreateBatched(
    inputs: readonly CreateHookExecutionInput[],
    limits: WriteBatchLimits = ACTIVE_TURN_WRITE_BATCH_LIMITS,
    replaceExisting = false,
  ): Promise<WriteBatchResult> {
    return runBoundedWriteBatches({
      db: this.db,
      items: inputs,
      limits,
      byteLength: (item) => Buffer.byteLength(JSON.stringify(item), "utf8"),
      write: (item) => {
        const { id, ...rest } = {
          id: item.id ?? NodeCrypto.randomUUID(),
          messageId: item.messageId,
          hookName: item.hookName,
          toolName: item.toolName,
          phase: item.phase,
          payload: item.payload,
          durationMs: item.durationMs,
          didBlock: item.didBlock ? 1 : 0,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          sortOrder: item.sortOrder,
        };
        const builder = this.orm.insert(hookExecutions).values({ id, ...rest });
        if (replaceExisting) {
          builder
            .onConflictDoUpdate({ target: hookExecutions.id, set: rest })
            .run();
        } else {
          builder.onConflictDoNothing().run();
        }
      },
    });
  }

  /** List all hook executions for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): HookExecutionRecord[] {
    const rows = this.orm
      .select()
      .from(hookExecutions)
      .where(eq(hookExecutions.messageId, messageId))
      .orderBy(asc(hookExecutions.sortOrder))
      .all();
    return rows.map(rowToRecord);
  }

  /** List hook executions for many messages in one indexed query, grouped by message id. */
  listByMessages(messageIds: readonly string[]): Map<string, HookExecutionRecord[]> {
    const grouped = new Map<string, HookExecutionRecord[]>();
    if (messageIds.length === 0) return grouped;

    const rows = this.orm
      .select()
      .from(hookExecutions)
      .where(inArray(hookExecutions.messageId, [...messageIds]))
      .orderBy(asc(hookExecutions.messageId), asc(hookExecutions.sortOrder))
      .all();

    for (const row of rows) {
      const record = rowToRecord(row);
      const list = grouped.get(record.message_id) ?? [];
      list.push(record);
      grouped.set(record.message_id, list);
    }
    return grouped;
  }

  /** Count the number of hook executions for a message. */
  countByMessage(messageId: string): number {
    const row = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(hookExecutions)
      .where(eq(hookExecutions.messageId, messageId))
      .get();
    return row?.count ?? 0;
  }
}
