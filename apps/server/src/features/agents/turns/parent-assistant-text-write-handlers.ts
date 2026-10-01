import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { ParentAssistantTextCheckpointStore } from "./parent-assistant-text-checkpoint-store.js";
import { parentAssistantTextWriteOperations as operations } from "./parent-assistant-text-write-operations.js";

/** Construct synchronous text commands; journal deletion happens after the command's outer commit. */
export function parentAssistantTextWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ParentAssistantTextCheckpointStore(db);
  return new Map([
    [operations.appendChunk.name, databaseWriteHandler(operations.appendChunk, (input) => store.appendChunk(input))],
    [operations.appendRecoveredChunk.name, databaseWriteHandler(operations.appendRecoveredChunk, (input) => store.appendRecoveredChunk(input))],
    [operations.reset.name, databaseWriteHandler(operations.reset, (input) => store.resetInTransaction(input))],
    [operations.resetForRetry.name, databaseWriteHandler(operations.resetForRetry, (input) => store.resetForRetryInTransaction(input))],
    [operations.retire.name, databaseWriteHandler(operations.retire, (input) => store.retireInTransaction(input))],
    [operations.retireTerminalCheckpoints.name, databaseWriteHandler(operations.retireTerminalCheckpoints, () => store.retireTerminalCheckpoints())],
  ]);
}
