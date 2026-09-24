/**
 * Generates and persists AI-powered diff summaries for threads.
 * Ties together ThreadDiffSource, buildDiffSummaryPrompt, UtilityCompletionService,
 * and the diff_summaries DB table into a single orchestration layer.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { logger } from "@mcode/shared";
import { UtilityCompletionService } from "../../../../shared/completion/utility-completion-service.js";
import { SnapshotService } from "../snapshots/snapshot-service.js";
import type { GitExecutor } from "../../git/execution/index.js";
import { ThreadDiffSource } from "./diff-summary-source.js";
import type { TurnSnapshotRow } from "./diff-summary-source.js";
import { buildDiffSummaryPrompt } from "./diff-summary-prompt.js";
import { diffSummaries } from "../../../../runtime/persistence/sqlite/schema.js";

/** A persisted diff summary record. */
export interface DiffSummaryRecord {
  id: string;
  threadId: string;
  content: string;
  turnCount: number;
  lastTurnId: string | null;
  model: string;
  createdAt: string;
}

type DiffSummaryRow = typeof diffSummaries.$inferSelect;

/** Maps a raw DB row to the public DiffSummaryRecord shape. */
function rowToRecord(row: DiffSummaryRow): DiffSummaryRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    content: row.content,
    turnCount: row.turnCount,
    lastTurnId: row.lastTurnId,
    model: row.model,
    createdAt: row.createdAt,
  };
}

/**
 * Generates and persists AI-powered diff summaries for threads.
 */
@injectable()
export class DiffSummaryService {
  private readonly orm: BunSQLiteDatabase;

  constructor(
    @inject(UtilityCompletionService)
    private readonly utilityCompletion: UtilityCompletionService,
    @inject(SnapshotService)
    private readonly snapshotService: SnapshotService,
    @inject("GitExecutor")
    private readonly gitExecutor: GitExecutor,
    @inject("Database")
    db: Database,
  ) {
    this.orm = drizzle(db);
  }

  /** Get the stored summary for a thread, if one exists. */
  get(threadId: string): DiffSummaryRecord | null {
    const row = this.orm
      .select()
      .from(diffSummaries)
      .where(eq(diffSummaries.threadId, threadId))
      .limit(1)
      .get();
    return row ? rowToRecord(row) : null;
  }

  /**
   * Generate a summary from pre-fetched snapshots.
   * Used by the RPC handler which already has the snapshots and cwd.
   */
  async generateFromSnapshots(
    threadId: string,
    snapshots: TurnSnapshotRow[],
    cwd: string,
  ): Promise<DiffSummaryRecord> {
    const source = new ThreadDiffSource(
      snapshots,
      cwd,
      this.snapshotService,
      this.gitExecutor,
    );

    const payload = await source.getDiff();

    if (payload.turnCount === 0) {
      throw new Error("No file changes to summarize");
    }

    const prompt = buildDiffSummaryPrompt(payload);
    const { text: content, model } = await this.utilityCompletion.complete(prompt, cwd);

    const record: DiffSummaryRecord = {
      id: NodeCrypto.randomUUID(),
      threadId,
      content,
      turnCount: payload.turnCount,
      lastTurnId: payload.lastTurnId,
      model,
      createdAt: new Date().toISOString(),
    };

    // Atomic upsert via INSERT OR REPLACE (unique index on thread_id)
    this.orm
      .insert(diffSummaries)
      .values({
        id: record.id,
        threadId: record.threadId,
        content: record.content,
        turnCount: record.turnCount,
        lastTurnId: record.lastTurnId,
        model: record.model,
        createdAt: record.createdAt,
      })
      .onConflictDoUpdate({
        target: diffSummaries.threadId,
        set: {
          id: record.id,
          content: record.content,
          turnCount: record.turnCount,
          lastTurnId: record.lastTurnId,
          model: record.model,
          createdAt: record.createdAt,
        },
      })
      .run();

    logger.info(`Generated diff summary for thread ${threadId} (${payload.turnCount} turns)`);

    return record;
  }
}
