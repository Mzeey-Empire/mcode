/**
 * Data access for the `plans` table.
 *
 * Each plan is tied to a thread + message and carries a monotonically
 * increasing version number within that thread.
 */

import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as NodeCrypto from "node:crypto";
import type { PlanRecord, PlanStatus } from "@mcode/contracts";
import { plans } from "../../../../runtime/persistence/sqlite/schema.js";

type Row = typeof plans.$inferSelect;

@injectable()
export class PlanRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Insert a new plan, auto-assigning the next version number. */
  create(
    threadId: string,
    messageId: string,
    title: string,
    contentMd: string,
    sectionsJson: string | null,
    changeSummary: string | null,
  ): PlanRecord {
    const id = NodeCrypto.randomUUID();
    const versionRow = this.orm
      .select({ next: sql<number>`COALESCE(MAX(${plans.version}), 0) + 1` })
      .from(plans)
      .where(eq(plans.threadId, threadId))
      .get();
    const version = versionRow?.next ?? 1;

    this.orm
      .update(plans)
      .set({ status: "superseded" })
      .where(and(eq(plans.threadId, threadId), eq(plans.status, "draft")))
      .run();

    this.orm
      .insert(plans)
      .values({
        id,
        threadId,
        messageId,
        version,
        title,
        contentMd,
        sectionsJson,
        changeSummary,
        status: "draft",
      })
      .run();

    const row = this.orm
      .select()
      .from(plans)
      .where(eq(plans.id, id))
      .get();
    return this.toRecord(row as Row);
  }

  /** Update a plan's status (draft -> accepted, etc.). */
  updateStatus(planId: string, status: PlanStatus): void {
    this.orm
      .update(plans)
      .set({ status })
      .where(eq(plans.id, planId))
      .run();
  }

  /** All plan versions for a thread, oldest first. */
  listByThread(threadId: string): PlanRecord[] {
    const rows = this.orm
      .select()
      .from(plans)
      .where(eq(plans.threadId, threadId))
      .orderBy(asc(plans.version))
      .all();
    return rows.map(this.toRecord);
  }

  /** Most recent non-superseded plan for a thread, or null. */
  getLatestForThread(threadId: string): PlanRecord | null {
    const row = this.orm
      .select()
      .from(plans)
      .where(and(eq(plans.threadId, threadId), ne(plans.status, "superseded")))
      .orderBy(desc(plans.version))
      .limit(1)
      .get();
    return row ? this.toRecord(row) : null;
  }

  /** Single plan by ID. */
  getById(planId: string): PlanRecord | null {
    const row = this.orm
      .select()
      .from(plans)
      .where(eq(plans.id, planId))
      .get();
    return row ? this.toRecord(row) : null;
  }

  /** Find the plan bound to one durable assistant message. */
  getByMessageId(messageId: string): PlanRecord | null {
    const row = this.orm.select().from(plans).where(eq(plans.messageId, messageId)).get();
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: Row): PlanRecord {
    return {
      id: row.id,
      threadId: row.threadId,
      messageId: row.messageId,
      version: row.version,
      title: row.title,
      contentMd: row.contentMd,
      sectionsJson: row.sectionsJson ? JSON.parse(row.sectionsJson) : null,
      changeSummary: row.changeSummary,
      status: row.status as PlanRecord["status"],
      createdAt: row.createdAt,
    };
  }
}
