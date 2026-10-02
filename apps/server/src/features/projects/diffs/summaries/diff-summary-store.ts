import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { diffSummaries } from "../../../../runtime/persistence/sqlite/schema.js";
import type { DiffSummaryRecord } from "./diff-summary-service.js";

/** Persists one complete generated diff summary in the database owner. */
export class DiffSummaryStore {
  constructor(private readonly db: Database) {}

  /** Replace the unique per-thread summary after completion succeeds. */
  upsert(record: DiffSummaryRecord): DiffSummaryRecord {
    drizzle(this.db).insert(diffSummaries).values(record).onConflictDoUpdate({
      target: diffSummaries.threadId,
      set: { id: record.id, content: record.content, turnCount: record.turnCount, lastTurnId: record.lastTurnId, model: record.model, createdAt: record.createdAt },
    }).run();
    return record;
  }
}
