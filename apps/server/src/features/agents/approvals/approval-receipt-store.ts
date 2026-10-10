import * as NodeUtil from "node:util";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { asc, eq, inArray } from "drizzle-orm";
import { ApprovalReceiptRecordSchema, type ApprovalReceiptRecord } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { approvalReceipts, messages } from "../../../runtime/persistence/sqlite/schema.js";

/** Decode persisted decision JSON at the database boundary. */
export function approvalReceiptRecord(row: typeof approvalReceipts.$inferSelect): ApprovalReceiptRecord {
  return ApprovalReceiptRecordSchema().parse({
    id: row.id, message_id: row.messageId, tool_call_id: row.toolCallId,
    kind: row.kind, subject_label: row.subjectLabel, outcome: JSON.parse(row.outcome),
    origin: row.origin === null ? null : JSON.parse(row.origin), decided_at: row.decidedAt, sort_order: row.sortOrder,
  });
}

/** Synchronous receipt persistence; mutations run only on the application writer connection. */
export class ApprovalReceiptStore {
  private readonly orm;

  constructor(db: Database) { this.orm = drizzle(db); }

  /** Replayed decisions are no-ops; a request id cannot acquire different content. */
  create(record: ApprovalReceiptRecord): void {
    const existing = this.orm.select().from(approvalReceipts).where(eq(approvalReceipts.id, record.id)).get();
    if (existing) {
      if (!NodeUtil.isDeepStrictEqual(approvalReceiptRecord(existing), record)) {
        logger.error("Approval receipt identity conflicts with its saved content", { requestId: record.id });
        throw new Error("Approval receipt identity conflicts with its saved content");
      }
      return;
    }
    this.orm.insert(approvalReceipts).values({
      id: record.id, messageId: record.message_id, toolCallId: record.tool_call_id,
      kind: record.kind, subjectLabel: record.subject_label, outcome: JSON.stringify(record.outcome),
      origin: record.origin === null ? null : JSON.stringify(record.origin),
      decidedAt: record.decided_at, sortOrder: record.sort_order,
    }).run();
  }

  /** Reanchor identical canonical content when its assistant message becomes visible. */
  materialize(record: ApprovalReceiptRecord): void {
    const existing = this.orm.select().from(approvalReceipts).where(eq(approvalReceipts.id, record.id)).get();
    if (!existing || existing.messageId === record.message_id) return this.create(record);
    // Canonical recovery anchors on the prompt until the assistant message is published.
    this.create({ ...record, message_id: existing.messageId });
    const owners = this.orm.select({ threadId: messages.threadId }).from(messages)
      .where(inArray(messages.id, [existing.messageId, record.message_id])).all();
    if (owners.length !== 2 || owners[0]?.threadId !== owners[1]?.threadId) {
      logger.error("Approval receipt cannot move between threads", { requestId: record.id });
      throw new Error("Approval receipt cannot move between threads");
    }
    this.orm.update(approvalReceipts).set({ messageId: record.message_id }).where(eq(approvalReceipts.id, record.id)).run();
  }

  /** Read one message's decisions in narrative order. */
  listByMessage(messageId: string): ApprovalReceiptRecord[] {
    return this.listByMessages([messageId]).get(messageId) ?? [];
  }

  /** Read decisions for a bounded message page. */
  listByMessages(messageIds: string[]): Map<string, ApprovalReceiptRecord[]> {
    const result = new Map<string, ApprovalReceiptRecord[]>();
    if (messageIds.length === 0) return result;
    for (const row of this.orm.select().from(approvalReceipts).where(inArray(approvalReceipts.messageId, messageIds))
      .orderBy(asc(approvalReceipts.sortOrder), asc(approvalReceipts.id)).all()) {
      const records = result.get(row.messageId) ?? [];
      records.push(approvalReceiptRecord(row));
      result.set(row.messageId, records);
    }
    return result;
  }
}
