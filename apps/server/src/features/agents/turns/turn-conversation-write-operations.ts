import type { Database } from "bun:sqlite";
import { MessageSchema, SystemNoticeMetadataSchema } from "@mcode/contracts/models/message";
import { z } from "zod";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { MessageStore } from "../conversation/persistence/message-store.js";

/** Conversation writes that allocate their sequence and check duplicates on the writer connection. */
export const turnConversationWriteOperations = {
  systemNotice: databaseWriteOperation("turn-conversation.system-notice", z.object({
    threadId: z.string().min(1), content: z.string(), notice: SystemNoticeMetadataSchema().optional(),
  }).strict(), MessageSchema()),
};

/** Construct sequence-sensitive conversation commands for the shared worker allowlist. */
export function turnConversationWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const messages = new MessageStore(db);
  const operations = turnConversationWriteOperations;
  return new Map([
    [operations.systemNotice.name, databaseWriteHandler(operations.systemNotice, (input) => messages.createSystemNotice(
      input.threadId, input.content, messages.getLatestSequenceIncludingInternal(input.threadId) + 1, input.notice,
    ))],
  ]);
}
