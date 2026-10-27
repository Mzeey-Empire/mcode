/**
 * Plan-question wizard answered-marker data access layer.
 *
 * Records that the user has submitted answers for the plan-questions block
 * embedded in a specific assistant message. The marker is what suppresses the
 * wizard from re-popping after server restarts or mid-turn errors. Sidecar
 * table; FK CASCADE on both `assistant_message_id` and `thread_id` keeps it
 * self-pruning when parent rows are deleted.
 */

import type { Database } from "bun:sqlite";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { planQuestionAnswers } from "../../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";
import { NativePlanQuestionBatchSchema, type NativePlanQuestionBatch, type PlanQuestionSettlement } from "@mcode/contracts/models/plan-questions";
import { type Message } from "@mcode/contracts/models/message";
import { MessageStore } from "../../conversation/persistence/message-store.js";

/** Repository for the `plan_question_answers` sidecar table. */
export class PlanQuestionAnswersStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(private readonly db: Database) {
    this.orm = drizzle(db);
  }

  /**
   * Persist the answered marker for an assistant plan-questions message.
   * Idempotent: re-marking the same id is a no-op via INSERT OR IGNORE.
   */
  markAnswered(assistantMessageId: string, threadId: string): void {
    this.db.transaction(() => {
      const inserted = runChanges(this.orm.insert(planQuestionAnswers)
        .values({ id: assistantMessageId, assistantMessageId, threadId }).onConflictDoNothing());
      if (inserted.changes === 0) return;
      // Accepted dismissal can reach storage after its question publication was saved.
      this.db.prepare("UPDATE threads SET plan_phase = NULL, updated_at = ? WHERE id = ? AND plan_phase = 'questions'")
        .run(new Date().toISOString(), threadId);
    })();
  }

  /** True iff a marker exists for the given assistant message id. */
  isAnswered(assistantMessageId: string): boolean {
    const row = this.orm
      .select({ marker: sql`1` })
      .from(planQuestionAnswers)
      .where(eq(planQuestionAnswers.assistantMessageId, assistantMessageId))
      .get();
    return row !== undefined;
  }

  /** All answered assistant-message ids for a thread, oldest first. */
  listAnsweredForThread(threadId: string): string[] {
    const rows = this.orm
      .select({ assistantMessageId: planQuestionAnswers.assistantMessageId })
      .from(planQuestionAnswers)
      .where(eq(planQuestionAnswers.threadId, threadId))
      .orderBy(asc(planQuestionAnswers.answeredAt))
      .all();
    return rows.flatMap(row => row.assistantMessageId ? [row.assistantMessageId] : []);
  }

  /** Persist native question content before publishing an answerable dock. */
  createNative(batch: NativePlanQuestionBatch): void {
    this.db.transaction(() => {
      this.orm.insert(planQuestionAnswers).values({ id: batch.requestId, threadId: batch.threadId,
        nativeBatchJson: JSON.stringify(batch), status: "pending" }).run();
      this.db.prepare("UPDATE threads SET plan_phase = 'questions', updated_at = ? WHERE id = ? AND plan_phase IN ('planning', 'questions')")
        .run(new Date().toISOString(), batch.threadId);
    })();
  }

  /** Read live batches without trying to recreate a provider responder. */
  pendingNative(threadId?: string): NativePlanQuestionBatch[] {
    const rows = this.db.query<{ native_batch_json: string }, [string | null, string | null]>(
      "SELECT native_batch_json FROM plan_question_answers WHERE status = 'pending' AND native_batch_json IS NOT NULL AND (? IS NULL OR thread_id = ?) ORDER BY answered_at",
    ).all(threadId ?? null, threadId ?? null);
    return rows.map(row => NativePlanQuestionBatchSchema().parse(JSON.parse(row.native_batch_json)));
  }

  /** Atomically retire the dock and save its receipt, including restart expiry. */
  settleNative(batch: NativePlanQuestionBatch, status: PlanQuestionSettlement): Message | null {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE plan_question_answers SET status = ?, answered_at = ? WHERE id = ? AND thread_id = ? AND status = 'pending'")
        .run(status, new Date().toISOString(), batch.requestId, batch.threadId);
      if (changed.changes === 0) return null;
      const phase = status === "answered" ? "planning" : null;
      this.db.prepare("UPDATE threads SET plan_phase = ?, updated_at = ? WHERE id = ? AND plan_phase = 'questions'")
        .run(phase, new Date().toISOString(), batch.threadId);
      const messages = new MessageStore(this.db);
      return messages.createSystemNotice(batch.threadId, nativeQuestionReceipt(batch, status),
        messages.getLatestSequenceIncludingInternal(batch.threadId) + 1,
        { kind: "diagnostic", presentation: "timeline", scope: "turn", noticeKey: batch.requestId });
    })();
  }
}

function nativeQuestionReceipt(batch: NativePlanQuestionBatch, status: PlanQuestionSettlement): string {
  if (status === "expired") return "Questions expired";
  if (status === "dismissed") return "Questions dismissed";
  return `Answered ${batch.questions.length} ${batch.questions.length === 1 ? "question" : "questions"}`;
}
