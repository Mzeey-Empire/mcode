import { z } from "zod";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Content-free audit metadata is the only input accepted by the writer. */
export const threadControlAuditWriteOperations = {
  write: databaseWriteOperation("threadControlAudit.write", z.tuple([z.object({ callerId: z.string(), sourceThreadId: z.string().optional(), workspaceId: z.string().optional(), threadId: z.string().optional(), operation: z.string(), outcome: z.string() })]), z.void()),
};
