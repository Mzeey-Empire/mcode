/**
 * Thought segment record data access layer.
 * Provides creation and retrieval operations for persisted thought segments.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { ThoughtSegmentRecord } from "@mcode/contracts";
import {
  ACTIVE_TURN_WRITE_BATCH_LIMITS,
  runBoundedWriteBatches,
  type WriteBatchLimits,
  type WriteBatchResult,
} from "../../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { thoughtSegments } from "../../../../../runtime/persistence/sqlite/schema.js";

/** Row shape returned by drizzle for the thought_segments table. */
type ThoughtSegmentRow = typeof thoughtSegments.$inferSelect;

/** Input for creating a new thought segment record. */
export interface CreateThoughtSegmentInput {
  /** Optional explicit id; generated if omitted. */
  id?: string;
  messageId: string;
  text: string;
  startedAt: string;
  endedAt: string | null;
  sortOrder: number;
  /** Non-zero when this segment is the assistant's final user-facing response. */
  isFinalResponse?: number;
}

function rowToRecord(row: ThoughtSegmentRow): ThoughtSegmentRecord {
  return {
    id: row.id,
    message_id: row.messageId,
    text: row.text,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    sort_order: row.sortOrder,
    is_final_response: row.isFinalResponse,
  };
}

/** Repository for thought segment creation and retrieval against SQLite. */
@injectable()
export class ThoughtSegmentRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") private readonly db: Database) {
    this.orm = drizzle(db);
  }

  /** Create a single thought segment record and return the fully-populated record. */
  create(input: CreateThoughtSegmentInput): ThoughtSegmentRecord {
    const id = input.id ?? NodeCrypto.randomUUID();
    const isFinalResponse = input.isFinalResponse ?? 0;
    this.orm
      .insert(thoughtSegments)
      .values({
        id,
        messageId: input.messageId,
        text: input.text,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        sortOrder: input.sortOrder,
        isFinalResponse,
      })
      .onConflictDoNothing()
      .run();
    return {
      id,
      message_id: input.messageId,
      text: input.text,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      sort_order: input.sortOrder,
      is_final_response: isFinalResponse,
    };
  }

  /** Insert multiple thought segment records in a single transaction. */
  bulkCreate(inputs: CreateThoughtSegmentInput[], replaceExisting = false): void {
    if (inputs.length === 0) return;
    this.orm.transaction((tx) => {
      for (const item of inputs) {
        const { id, ...rest } = {
          id: item.id ?? NodeCrypto.randomUUID(),
          messageId: item.messageId,
          text: item.text,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          sortOrder: item.sortOrder,
          isFinalResponse: item.isFinalResponse ?? 0,
        };
        const write = tx.insert(thoughtSegments).values({ id, ...rest });
        if (replaceExisting) write.onConflictDoUpdate({ target: thoughtSegments.id, set: rest }).run();
        else write.onConflictDoNothing().run();
      }
    });
  }

  /** Insert thought rows in bounded transactions with an event-loop yield between commits. */
  async bulkCreateBatched(
    inputs: readonly CreateThoughtSegmentInput[],
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
          text: item.text,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          sortOrder: item.sortOrder,
          isFinalResponse: item.isFinalResponse ?? 0,
        };
        const builder = this.orm.insert(thoughtSegments).values({ id, ...rest });
        if (replaceExisting) {
          builder
            .onConflictDoUpdate({ target: thoughtSegments.id, set: rest })
            .run();
        } else {
          builder.onConflictDoNothing().run();
        }
      },
    });
  }

  /** List all thought segments for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): ThoughtSegmentRecord[] {
    const rows = this.orm
      .select()
      .from(thoughtSegments)
      .where(eq(thoughtSegments.messageId, messageId))
      .orderBy(asc(thoughtSegments.sortOrder))
      .all();
    return rows.map(rowToRecord);
  }

  /** List thought segments for many messages in one indexed query, grouped by message id. */
  listByMessages(messageIds: readonly string[]): Map<string, ThoughtSegmentRecord[]> {
    const grouped = new Map<string, ThoughtSegmentRecord[]>();
    if (messageIds.length === 0) return grouped;

    const rows = this.orm
      .select()
      .from(thoughtSegments)
      .where(inArray(thoughtSegments.messageId, [...messageIds]))
      .orderBy(asc(thoughtSegments.messageId), asc(thoughtSegments.sortOrder))
      .all();

    for (const row of rows) {
      const record = rowToRecord(row);
      const list = grouped.get(record.message_id) ?? [];
      list.push(record);
      grouped.set(record.message_id, list);
    }
    return grouped;
  }

  /** Count the number of thought segments for a message. */
  countByMessage(messageId: string): number {
    const row = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(thoughtSegments)
      .where(eq(thoughtSegments.messageId, messageId))
      .get();
    return row?.count ?? 0;
  }
}
