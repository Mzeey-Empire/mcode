/**
 * Narration segment record data access layer.
 * Provides creation and retrieval operations for persisted narration segments —
 * contiguous groups of assistant text deltas emitted before a tool call within a turn.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { NarrationSegmentRecord } from "@mcode/contracts";

/** Row shape returned by SQLite for the narration_segments table. */
interface NarrationSegmentRow {
  id: string;
  message_id: string;
  text: string;
  started_at: string;
  ended_at: string | null;
  sort_order: number;
  is_final_response: number;
}

/** Input for creating a new narration segment record. */
export interface CreateNarrationSegmentInput {
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

function rowToRecord(row: NarrationSegmentRow): NarrationSegmentRecord {
  return {
    id: row.id,
    message_id: row.message_id,
    text: row.text,
    started_at: row.started_at,
    ended_at: row.ended_at,
    sort_order: row.sort_order,
    is_final_response: row.is_final_response,
  };
}

const COLUMNS = "id, message_id, text, started_at, ended_at, sort_order, is_final_response";

/** Repository for narration segment creation and retrieval against SQLite. */
@injectable()
export class NarrationSegmentRepo {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtListByMessage: Database.Statement;
  private readonly stmtCountByMessage: Database.Statement;

  constructor(@inject("Database") private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      "INSERT OR IGNORE INTO narration_segments (id, message_id, text, started_at, ended_at, sort_order, is_final_response) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.stmtListByMessage = db.prepare(
      `SELECT ${COLUMNS} FROM narration_segments WHERE message_id = ? ORDER BY sort_order ASC`,
    );
    this.stmtCountByMessage = db.prepare(
      "SELECT COUNT(*) as count FROM narration_segments WHERE message_id = ?",
    );
  }

  /** Create a single narration segment record and return the fully-populated record. */
  create(input: CreateNarrationSegmentInput): NarrationSegmentRecord {
    const id = input.id ?? randomUUID();
    const isFinalResponse = input.isFinalResponse ?? 0;
    this.stmtInsert.run(
      id,
      input.messageId,
      input.text,
      input.startedAt,
      input.endedAt,
      input.sortOrder,
      isFinalResponse,
    );
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

  /** Insert multiple narration segment records in a single transaction. */
  bulkCreate(inputs: CreateNarrationSegmentInput[]): void {
    if (inputs.length === 0) return;
    const tx = this.db.transaction((items: CreateNarrationSegmentInput[]) => {
      for (const item of items) {
        this.stmtInsert.run(
          item.id ?? randomUUID(),
          item.messageId,
          item.text,
          item.startedAt,
          item.endedAt,
          item.sortOrder,
          item.isFinalResponse ?? 0,
        );
      }
    });
    tx(inputs);
  }

  /** List all narration segments for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): NarrationSegmentRecord[] {
    const rows = this.stmtListByMessage.all(messageId) as NarrationSegmentRow[];
    return rows.map(rowToRecord);
  }

  /** Count the number of narration segments for a message. */
  countByMessage(messageId: string): number {
    const row = this.stmtCountByMessage.get(messageId) as { count: number };
    return row.count;
  }
}
