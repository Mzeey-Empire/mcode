import { z } from "zod";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Bounded runtime conversion checkpoints executed by the application writer. */
export const conversationConversionWriteOperations = {
  legacyBatch: databaseWriteOperation("conversation.convertLegacyBatch", z.void(), z.object({
    processedMessages: z.number().int().nonnegative(),
    migratedMessages: z.number().int().nonnegative(),
    ambiguousMessages: z.number().int().nonnegative(),
    completed: z.boolean(),
  })),
  displayBatch: databaseWriteOperation("conversation.materializeDisplayBatch", z.void(), z.boolean()),
};
