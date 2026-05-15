/**
 * Thought segment record data access layer.
 * Provides creation and retrieval operations for persisted thought segments.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { ThoughtSegmentRecord } from "@mcode/contracts";

/** Row shape returned by SQLite for the thought_segments table. */
interface ThoughtSegmentRow {
  id: string;
  message_id: string;
  text: string;
  started_at: string;
  ended_at: string | null;
  sort_order: number;
}

/** Input for creating a new thought segment record. */
export interface CreateThoughtSegmentInput {
  /** Optional explicit id; generated if omitted. */
  id?: string;
  messageId: string;
  text: string;
  startedAt: string;
  endedAt: string | null;
  sortOrder: number;
}

function rowToRecord(row: ThoughtSegmentRow): ThoughtSegmentRecord {
  return {
    id: row.id,
    message_id: row.message_id,
    text: row.text,
    started_at: row.started_at,
    ended_at: row.ended_at,
    sort_order: row.sort_order,
  };
}

const COLUMNS = "id, message_id, text, started_at, ended_at, sort_order";

/** Repository for thought segment creation and retrieval against SQLite. */
@injectable()
export class ThoughtSegmentRepo {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtListByMessage: Database.Statement;
  private readonly stmtCountByMessage: Database.Statement;

  constructor(@inject("Database") private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      "INSERT OR IGNORE INTO thought_segments (id, message_id, text, started_at, ended_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.stmtListByMessage = db.prepare(
      `SELECT ${COLUMNS} FROM thought_segments WHERE message_id = ? ORDER BY sort_order ASC`,
    );
    this.stmtCountByMessage = db.prepare(
      "SELECT COUNT(*) as count FROM thought_segments WHERE message_id = ?",
    );
  }

  /** Create a single thought segment record and return the fully-populated record. */
  create(input: CreateThoughtSegmentInput): ThoughtSegmentRecord {
    const id = input.id ?? randomUUID();
    this.stmtInsert.run(
      id,
      input.messageId,
      input.text,
      input.startedAt,
      input.endedAt,
      input.sortOrder,
    );
    return {
      id,
      message_id: input.messageId,
      text: input.text,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      sort_order: input.sortOrder,
    };
  }

  /** Insert multiple thought segment records in a single transaction. */
  bulkCreate(inputs: CreateThoughtSegmentInput[]): void {
    if (inputs.length === 0) return;
    const tx = this.db.transaction((items: CreateThoughtSegmentInput[]) => {
      for (const item of items) {
        this.stmtInsert.run(
          item.id ?? randomUUID(),
          item.messageId,
          item.text,
          item.startedAt,
          item.endedAt,
          item.sortOrder,
        );
      }
    });
    tx(inputs);
  }

  /** List all thought segments for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): ThoughtSegmentRecord[] {
    const rows = this.stmtListByMessage.all(messageId) as ThoughtSegmentRow[];
    return rows.map(rowToRecord);
  }

  /** Count the number of thought segments for a message. */
  countByMessage(messageId: string): number {
    const row = this.stmtCountByMessage.get(messageId) as { count: number };
    return row.count;
  }
}
