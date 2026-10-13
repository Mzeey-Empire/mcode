import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { TurnRevertRecordSchema, TurnRevertResultSchema } from "@mcode/contracts";
import { turnReverts } from "../../../../runtime/persistence/sqlite/schema.js";
import { RevertContextSchema, RecoveryPathSchema } from "../../../projects/diffs/revert/turn-revert-model.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";

const revertFiles = z.array(RecoveryPathSchema).max(512);
const revertFailure = z.object({ paths: z.array(z.string()), detail: z.string() });

/** Decode JSON once at the storage boundary. */
export function decodeRevert(row: typeof turnReverts.$inferSelect) {
  return { ...row, files: revertFiles.parse(JSON.parse(row.files)),
    context: RevertContextSchema.parse(JSON.parse(row.requestParams)),
    failure: row.failure ? revertFailure.parse(JSON.parse(row.failure)) : null };
}
/** Durable journal entry with validated raw states. */
export type StoredRevert = ReturnType<typeof decodeRevert>;

/** Read-only journal access. Mutations belong to the application database writer. */
export class TurnRevertStore {
  constructor(private readonly db: Database) {}
  /** Unreported reverts whose changes still stand, in deterministic journal order. */
  pendingAgentNotice(threadId: string) {
    const rows = drizzle(this.db).select().from(turnReverts).where(and(
      eq(turnReverts.threadId, threadId), eq(turnReverts.state, "committed"),
      inArray(turnReverts.kind, ["turn", "file"]), isNull(turnReverts.undoneByRevertId),
      isNull(turnReverts.agentNotifiedAt),
    )).orderBy(asc(turnReverts.createdAt), asc(turnReverts.id)).all().map(decodeRevert);
    return {
      revertIds: rows.map((row) => row.id),
      paths: [...new Set(rows.flatMap((row) => row.files.map((file) => file.path)))],
    };
  }
  /** Find one operation by id. */
  get(id: string): StoredRevert | null {
    const row = drizzle(this.db).select().from(turnReverts).where(eq(turnReverts.id, id)).get();
    return row ? decodeRevert(row) : null;
  }
  /** Request identity survives Undo and later reverts. */
  byRequest(requestId: string): StoredRevert | null {
    const row = drizzle(this.db).select().from(turnReverts).where(eq(turnReverts.requestId, requestId)).get();
    return row ? decodeRevert(row) : null;
  }
  /** Rows startup must retry regardless of age. */
  /** Newest first: a retry wrote over its failed predecessor, so it must be unwound before the predecessor is judged. */
  unfinished(): StoredRevert[] {
    return drizzle(this.db).select().from(turnReverts).where(inArray(turnReverts.state, ["prepared", "recovery_failed"]))
      .orderBy(desc(turnReverts.createdAt)).all().map(decodeRevert);
  }
  /** Paths a later committed operation in the same checkout has written since `row` was prepared. */
  laterCommittedPaths(row: StoredRevert): Set<string> {
    const later = drizzle(this.db).select().from(turnReverts)
      .where(and(eq(turnReverts.state, "committed"), gt(turnReverts.createdAt, row.createdAt))).all().map(decodeRevert);
    return new Set(later.filter((other) => other.context.cwd === row.context.cwd).flatMap((other) => other.files.map((file) => file.path)));
  }
  /** Load the thread's committed operations once for all snapshot markers. */
  revertedPathsBySnapshot(threadId: string): Map<string, Set<string>> {
    const paths = new Map<string, Set<string>>();
    const rows = drizzle(this.db).select().from(turnReverts)
      .where(and(eq(turnReverts.threadId, threadId), eq(turnReverts.state, "committed"))).all().map(decodeRevert);
    for (const row of rows) {
      if (row.kind === "undo" || row.undoneByRevertId) continue;
      for (const snapshotId of row.context.snapshotIds) {
        const reverted = paths.get(snapshotId) ?? new Set<string>();
        for (const file of row.files) reverted.add(file.path);
        paths.set(snapshotId, reverted);
      }
    }
    return paths;
  }
  /** Reconstruct the recorded outcome without inspecting or writing the worktree. */
  outcome(row: StoredRevert) {
    if (row.state !== "committed") return TurnRevertResultSchema().parse({ status: "failed",
      outcome: row.state === "recovery_failed" ? "recovery_failed" : "rolled_back",
      paths: row.failure?.paths ?? [], detail: row.failure?.detail ?? "Interrupted revert" });
    if (!row.receiptMessageId) throw new Error("Committed revert is missing its receipt");
    const receipt = new MessageStore(this.db).findById(row.receiptMessageId);
    const revert = TurnRevertRecordSchema().parse({ ...row, undoneByRevertId: null, receiptMessageId: row.receiptMessageId });
    return TurnRevertResultSchema().parse({ status: "reverted", revert, receipt });
  }
}
