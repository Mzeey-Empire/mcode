import { z } from "zod";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

const settledDiff = z.object({
  id: z.string(), message_id: z.string(), thread_id: z.string(), source: z.enum(["native", "tracked", "git"]),
  patch: z.string().nullable(), revision: z.number().int().nonnegative(),
}).strict();

/** Settled turn comparisons admitted to the shared owner. */
export const turnDiffWriteOperations = {
  create: databaseWriteOperation("turnDiff.create", z.tuple([settledDiff]), z.void()),
};
