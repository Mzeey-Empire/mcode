import type { Database } from "bun:sqlite";

/** Only active canonical executions exclude serialized user plan writes. */
export function hasUnfinishedPlanExecution(db: Database, threadId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM canonical_agent_ingest_checkpoints checkpoint
    JOIN canonical_agent_turns turn ON turn.id = checkpoint.turn_id
    WHERE checkpoint.thread_id = ? AND checkpoint.terminal_outcome IS NULL
      AND turn.status IN ('Pending', 'Running') LIMIT 1`).get(threadId));
}

/** A prepared Implement snapshot holds plan writes until admission or compensation. */
export function hasPreparingPlanImplement(db: Database, threadId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM plan_implement_requests WHERE source_thread_id = ? AND status = 'preparing'").get(threadId));
}
