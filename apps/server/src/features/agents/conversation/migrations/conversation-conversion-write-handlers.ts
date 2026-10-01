import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { LegacyConversationMigrationStore } from "./legacy-conversation-migration-store.js";
import { ConversationDisplayMaterializationStore } from "./conversation-display-materialization-store.js";
import { conversationConversionWriteOperations } from "./conversation-conversion-write-operations.js";

/** Construct complete conversion operations against the writer's connection. */
export function conversationConversionWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const legacy = new LegacyConversationMigrationStore(db);
  const display = new ConversationDisplayMaterializationStore(db);
  const operations = conversationConversionWriteOperations;
  return new Map([
    [operations.legacyBatch.name, databaseWriteHandler(operations.legacyBatch, () => legacy.runBatch())],
    [operations.displayBatch.name, databaseWriteHandler(operations.displayBatch, () => display.runBatch())],
  ]);
}
