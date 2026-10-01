import type { Database } from "bun:sqlite";
import { MessageSchema, SystemNoticeMetadataSchema } from "@mcode/contracts";
import { z } from "zod";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { MessageStore } from "../conversation/persistence/message-store.js";

/** Conversation writes that allocate their sequence and check duplicates on the writer connection. */
export const turnConversationWriteOperations = {
  compactionDivider: databaseWriteOperation("turn-conversation.compaction-divider", z.string().min(1), z.void()),
  systemNotice: databaseWriteOperation("turn-conversation.system-notice", z.object({
    threadId: z.string().min(1), content: z.string(), notice: SystemNoticeMetadataSchema().optional(),
  }).strict(), MessageSchema()),
  goalReceipt: databaseWriteOperation("turn-conversation.goal-receipt", z.object({
    threadId: z.string().min(1), messageId: z.string().min(1), content: z.string(), model: z.string().nullable(),
  }).strict(), MessageSchema()),
};

/** Construct sequence-sensitive conversation commands for the shared worker allowlist. */
export function turnConversationWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const messages = new MessageStore(db);
  const operations = turnConversationWriteOperations;
  return new Map([
    [operations.compactionDivider.name, databaseWriteHandler(operations.compactionDivider, (threadId) => {
      messages.create(threadId, "system", "Context compacted", messages.getLatestSequenceIncludingInternal(threadId) + 1);
    })],
    [operations.systemNotice.name, databaseWriteHandler(operations.systemNotice, (input) => messages.createSystemNotice(
      input.threadId, input.content, messages.getLatestSequenceIncludingInternal(input.threadId) + 1, input.notice,
    ))],
    [operations.goalReceipt.name, databaseWriteHandler(operations.goalReceipt, (input) => {
      const existing = messages.findByIdInThreadIncludingInternal(input.threadId, input.messageId);
      if (existing) {
        if (existing.role !== "assistant" || existing.content !== input.content) {
          throw new Error("Goal receipt identity conflicts with its saved content");
        }
        return existing;
      }
      return messages.create(input.threadId, "assistant", input.content,
        messages.getLatestSequenceIncludingInternal(input.threadId) + 1, undefined, undefined, undefined, input.model,
        undefined, undefined, undefined, undefined, input.messageId);
    })],
  ]);
}
