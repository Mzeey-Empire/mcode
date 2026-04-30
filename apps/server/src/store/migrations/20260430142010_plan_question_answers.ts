import type Database from "better-sqlite3";

/**
 * Sidecar table that records which assistant plan-questions messages have
 * been answered by the user. Used to suppress the plan-question wizard from
 * re-popping after restart or mid-turn errors. Keyed on the assistant message
 * id so a thread can answer multiple plan-question rounds independently. ON
 * DELETE CASCADE on both FKs keeps the table self-pruning when threads or
 * messages are deleted.
 */
export const description = "Add plan_question_answers sidecar table";

const UP_SQL = `
CREATE TABLE plan_question_answers (
  assistant_message_id TEXT PRIMARY KEY
    REFERENCES messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL
    REFERENCES threads(id) ON DELETE CASCADE,
  answered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_plan_question_answers_thread
  ON plan_question_answers(thread_id);
`;

const DOWN_SQL = `
DROP INDEX IF EXISTS idx_plan_question_answers_thread;
DROP TABLE IF EXISTS plan_question_answers;
`;

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec(UP_SQL);
}

/** Reverse this migration. */
export function down(db: Database.Database): void {
  db.exec(DOWN_SQL);
}
