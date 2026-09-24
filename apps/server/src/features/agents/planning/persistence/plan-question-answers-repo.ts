/**
 * Plan-question wizard answered-marker data access layer.
 *
 * Records that the user has submitted answers for the plan-questions block
 * embedded in a specific assistant message. The marker is what suppresses the
 * wizard from re-popping after server restarts or mid-turn errors. Sidecar
 * table; FK CASCADE on both `assistant_message_id` and `thread_id` keeps it
 * self-pruning when parent rows are deleted.
 */

import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { planQuestionAnswers } from "../../../../runtime/persistence/sqlite/schema.js";

/** Repository for the `plan_question_answers` sidecar table. */
@injectable()
export class PlanQuestionAnswersRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /**
   * Persist the answered marker for an assistant plan-questions message.
   * Idempotent: re-marking the same id is a no-op via INSERT OR IGNORE.
   */
  markAnswered(assistantMessageId: string, threadId: string): void {
    this.orm
      .insert(planQuestionAnswers)
      .values({ assistantMessageId, threadId })
      .onConflictDoNothing()
      .run();
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
    return rows.map((r) => r.assistantMessageId);
  }
}
