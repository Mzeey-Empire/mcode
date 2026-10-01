import type { Database } from "bun:sqlite";
import { z } from "zod";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { MessageStore } from "../conversation/persistence/message-store.js";

/** User text and its goal control reply commit together before synthesized publication. */
export const goalCommandWriteOperations = {
  persistControlReply: databaseWriteOperation("goalCommand.persistControlReply", z.object({ threadId: z.string(), userText: z.string(), replyText: z.string() }), z.object({ assistantMessageId: z.string() })),
};

/** Read the latest sequence and append both rows on the writer's complete transaction. */
export function goalCommandWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const messages = new MessageStore(db);
  const operation = goalCommandWriteOperations.persistControlReply;
  return new Map([
    [operation.name, databaseWriteHandler(operation, ({ threadId, userText, replyText }) => {
      const baseSequence = messages.getLatestSequenceIncludingInternal(threadId);
      messages.create(threadId, "user", userText, baseSequence + 1);
      const assistant = messages.create(threadId, "assistant", replyText, baseSequence + 2);
      return { assistantMessageId: assistant.id };
    })],
  ]);
}
