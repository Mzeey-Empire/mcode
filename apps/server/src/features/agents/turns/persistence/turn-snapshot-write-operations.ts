import { z } from "zod";
import { TurnSnapshotSchema, TurnFileEffectSummarySchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Validated snapshot input preserves provider-neutral authored effects. */
export const snapshotInput = z.object({
  messageId: z.string(), threadId: z.string(), refBefore: z.string(), refAfter: z.string(), filesChanged: z.array(z.string()),
  fileEffects: TurnFileEffectSummarySchema().optional(), worktreePath: z.string().nullable(),
}).strict();

/** Snapshot persistence and retention admitted to the shared owner. */
export const turnSnapshotWriteOperations = {
  create: databaseWriteOperation("turnSnapshot.create", z.tuple([snapshotInput]), TurnSnapshotSchema()),
  deleteExpired: databaseWriteOperation("turnSnapshot.deleteExpired", z.tuple([z.number().int().nonnegative()]), z.number().int().nonnegative()),
};
