import { z } from "zod";
import { ThreadStartupSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";

/** Explicit low-level snapshot writes, executed only on the shared owner. */
export const threadStartupWriteOperations = {
  insert: databaseWriteOperation("threadStartup.insert", z.tuple([ThreadStartupSchema(), z.string().optional()]), z.void()),
  update: databaseWriteOperation("threadStartup.update", z.tuple([ThreadStartupSchema()]), z.void()),
};
