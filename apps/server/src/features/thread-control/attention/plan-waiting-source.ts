import type { Database } from "bun:sqlite";
import type { ThreadWaitingSource } from "./thread-attention-service.js";

/** Hydrate planning attention without opening a thread or starting its provider. */
export function planWaitingSource(db: Database, kind: "questions" | "plan"): ThreadWaitingSource {
  const phase = kind === "questions" ? "questions" : "ready";
  return {
    kind,
    listWaiting: () => new Map(db.query<{ id: string; updated_at: string }, [string]>(
      "SELECT id, updated_at FROM threads WHERE plan_phase = ? AND deleted_at IS NULL",
    ).all(phase).map((row) => [row.id, row.updated_at])),
  };
}
