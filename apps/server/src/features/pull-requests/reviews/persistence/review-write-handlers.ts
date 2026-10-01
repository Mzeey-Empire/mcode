import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { PullRequestReviewLinkStore } from "./pull-request-review-link-store.js";
import { reviewWriteOperations } from "./review-write-operations.js";

/** Review operation contribution uses only the worker's writable connection. */
export function reviewWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new PullRequestReviewLinkStore(db);
  const ops = reviewWriteOperations;
  return new Map([
    [ops.insert.name, databaseWriteHandler(ops.insert, input => store.insert(...input))],
    [ops.replaceLocalCheckout.name, databaseWriteHandler(ops.replaceLocalCheckout, input => store.replaceLocalCheckout(...input))],
    [ops.updateRemoteState.name, databaseWriteHandler(ops.updateRemoteState, input => store.updateRemoteState(...input))],
    [ops.updatePrimaryThread.name, databaseWriteHandler(ops.updatePrimaryThread, input => store.updatePrimaryThread(...input))],
    [ops.clearPrimaryThreadByThreadId.name, databaseWriteHandler(ops.clearPrimaryThreadByThreadId, input => store.clearPrimaryThreadByThreadId(...input))],
    [ops.persistReviewTask.name, databaseWriteHandler(ops.persistReviewTask, input => store.persistReviewTask(...input))],
  ]);
}
