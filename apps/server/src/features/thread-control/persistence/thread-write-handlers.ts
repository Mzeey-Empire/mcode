import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { ThreadStore } from "./thread-store.js";
import { threadWriteOperations } from "./thread-write-operations.js";

/** Register synchronous complete operations on the application writer connection. */
export function buildThreadStoreWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ThreadStore(db);
  return new Map<string, (input: unknown) => unknown>([
    [threadWriteOperations.create.name, databaseWriteHandler(threadWriteOperations.create, (input) => store.create(...input))],
    [threadWriteOperations.updateStatus.name, databaseWriteHandler(threadWriteOperations.updateStatus, (input) => store.updateStatus(...input))],
    [threadWriteOperations.complete.name, databaseWriteHandler(threadWriteOperations.complete, (input) => store.complete(...input))],
    [threadWriteOperations.updateCompletedThreadDeadlines.name, databaseWriteHandler(threadWriteOperations.updateCompletedThreadDeadlines, (input) => store.updateCompletedThreadDeadlines(...input))],
    [threadWriteOperations.reopen.name, databaseWriteHandler(threadWriteOperations.reopen, (input) => store.reopen(...input))],
    [threadWriteOperations.claimRetentionCleanup.name, databaseWriteHandler(threadWriteOperations.claimRetentionCleanup, (input) => store.claimRetentionCleanup(...input))],
    [threadWriteOperations.releaseRetentionCleanup.name, databaseWriteHandler(threadWriteOperations.releaseRetentionCleanup, (input) => store.releaseRetentionCleanup(...input))],
    [threadWriteOperations.blockRetentionCleanup.name, databaseWriteHandler(threadWriteOperations.blockRetentionCleanup, (input) => store.blockRetentionCleanup(...input))],
    [threadWriteOperations.retryRetentionCleanup.name, databaseWriteHandler(threadWriteOperations.retryRetentionCleanup, (input) => store.retryRetentionCleanup(...input))],
    [threadWriteOperations.updateWorktreePath.name, databaseWriteHandler(threadWriteOperations.updateWorktreePath, (input) => store.updateWorktreePath(...input))],
    [threadWriteOperations.clearWorktreePath.name, databaseWriteHandler(threadWriteOperations.clearWorktreePath, (input) => store.clearWorktreePath(...input))],
    [threadWriteOperations.updateCheckoutToNamedBranch.name, databaseWriteHandler(threadWriteOperations.updateCheckoutToNamedBranch, (input) => store.updateCheckoutToNamedBranch(...input))],
    [threadWriteOperations.updateCheckoutFromHead.name, databaseWriteHandler(threadWriteOperations.updateCheckoutFromHead, (input) => store.updateCheckoutFromHead(...input))],
    [threadWriteOperations.softDelete.name, databaseWriteHandler(threadWriteOperations.softDelete, (input) => store.softDelete(...input))],
    [threadWriteOperations.hardDelete.name, databaseWriteHandler(threadWriteOperations.hardDelete, (input) => store.hardDelete(...input))],
    [threadWriteOperations.updateProvider.name, databaseWriteHandler(threadWriteOperations.updateProvider, (input) => store.updateProvider(...input))],
    [threadWriteOperations.updateModel.name, databaseWriteHandler(threadWriteOperations.updateModel, (input) => store.updateModel(...input))],
    [threadWriteOperations.updateSdkSessionId.name, databaseWriteHandler(threadWriteOperations.updateSdkSessionId, (input) => store.updateSdkSessionId(...input))],
    [threadWriteOperations.clearSdkSessionId.name, databaseWriteHandler(threadWriteOperations.clearSdkSessionId, (input) => store.clearSdkSessionId(...input))],
    [threadWriteOperations.updatePr.name, databaseWriteHandler(threadWriteOperations.updatePr, (input) => store.updatePr(...input))],
    [threadWriteOperations.updateContextUsage.name, databaseWriteHandler(threadWriteOperations.updateContextUsage, (input) => store.updateContextUsage(...input))],
    [threadWriteOperations.updateSettings.name, databaseWriteHandler(threadWriteOperations.updateSettings, (input) => store.updateSettings(...input))],
    [threadWriteOperations.updateTitle.name, databaseWriteHandler(threadWriteOperations.updateTitle, (input) => store.updateTitle(...input))],
    [threadWriteOperations.updateCompactSummary.name, databaseWriteHandler(threadWriteOperations.updateCompactSummary, (input) => store.updateCompactSummary(...input))],
    [threadWriteOperations.updateLineage.name, databaseWriteHandler(threadWriteOperations.updateLineage, (input) => store.updateLineage(...input))],
    [threadWriteOperations.updateDelegationLineage.name, databaseWriteHandler(threadWriteOperations.updateDelegationLineage, (input) => store.updateDelegationLineage(...input))],
    [threadWriteOperations.updateExternalCreator.name, databaseWriteHandler(threadWriteOperations.updateExternalCreator, (input) => store.updateExternalCreator(...input))],
    [threadWriteOperations.nullifyExternalLineage.name, databaseWriteHandler(threadWriteOperations.nullifyExternalLineage, (input) => store.nullifyExternalLineage(...input))],
  ]);
}
