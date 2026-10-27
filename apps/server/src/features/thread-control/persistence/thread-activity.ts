import type { Database } from "bun:sqlite";
import { z } from "zod";
import { broadcast } from "../../../application/transport/push.js";

const activityRow = z.object({ last_activity_at: z.string().nullable() });
const pendingByDatabase = new WeakMap<Database, Map<string, string | null>>();
const listeners = new Set<(threadId: string) => void>();

/** Observe activity only after its database transaction commits. */
export function subscribeThreadActivity(listener: (threadId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Advance the turn activity clock monotonically. */
export function advanceThreadActivity(db: Database, threadId: string, at: string): boolean {
  const before = activityRow.nullable().parse(db.query(
    "SELECT last_activity_at FROM threads WHERE id = ?",
  ).get(threadId));
  if (!before) return false;
  const result = db.query(`UPDATE threads SET last_activity_at = ?, auto_complete_paused_at = NULL
    WHERE id = ? AND (last_activity_at IS NULL OR julianday(last_activity_at) < julianday(?))`)
    .run(at, threadId, at);
  if (result.changes === 0) return false;
  let pending = pendingByDatabase.get(db);
  if (!pending) {
    pending = new Map();
    pendingByDatabase.set(db, pending);
  }
  if (!pending.has(threadId)) pending.set(threadId, before.last_activity_at);
  return true;
}

/** Release only committed advances, discarding writes rolled back by an outer transaction. */
export function notifyCommittedThreadActivity(
  db: Database,
  notify: (activity: { threadId: string; at: string }) => void,
): void {
  if (db.inTransaction) throw new Error("Thread activity notification requires a committed transaction");
  const pending = pendingByDatabase.get(db);
  pendingByDatabase.delete(db);
  if (!pending) return;
  for (const [threadId, before] of pending) {
    const row = activityRow.nullable().parse(db.query(
      "SELECT last_activity_at FROM threads WHERE id = ?",
    ).get(threadId));
    if (row?.last_activity_at && (before === null || Date.parse(row.last_activity_at) > Date.parse(before))) {
      notify({ threadId, at: row.last_activity_at });
    }
  }
}

/** Publish a writer-confirmed advance on the application's WebSocket transport. */
export function publishThreadActivity(activity: { threadId: string; at: string }): void {
  broadcast("thread.activity", activity);
  for (const listener of listeners) listener(activity.threadId);
}
