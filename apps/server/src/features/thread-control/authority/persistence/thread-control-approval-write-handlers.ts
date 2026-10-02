import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { ThreadControlApprovalStore } from "./thread-control-approval-store.js";
import { threadControlApprovalWriteOperations } from "./thread-control-approval-write-operations.js";

/** Register synchronous complete operations on the application writer connection. */
export function buildThreadControlApprovalStoreWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ThreadControlApprovalStore(db);
  return new Map<string, (input: unknown) => unknown>([
    [threadControlApprovalWriteOperations.create.name, databaseWriteHandler(threadControlApprovalWriteOperations.create, (input) => store.create(...input))],
    [threadControlApprovalWriteOperations.createSend.name, databaseWriteHandler(threadControlApprovalWriteOperations.createSend, (input) => store.createSend(...input))],
    [threadControlApprovalWriteOperations.createStop.name, databaseWriteHandler(threadControlApprovalWriteOperations.createStop, (input) => store.createStop(...input))],
    [threadControlApprovalWriteOperations.claim.name, databaseWriteHandler(threadControlApprovalWriteOperations.claim, (input) => store.claim(...input))],
    [threadControlApprovalWriteOperations.setOperationPhase.name, databaseWriteHandler(threadControlApprovalWriteOperations.setOperationPhase, (input) => store.setOperationPhase(...input))],
    [threadControlApprovalWriteOperations.requeue.name, databaseWriteHandler(threadControlApprovalWriteOperations.requeue, (input) => store.requeue(...input))],
    [threadControlApprovalWriteOperations.requeueRecoveredProvisioning.name, databaseWriteHandler(threadControlApprovalWriteOperations.requeueRecoveredProvisioning, (input) => store.requeueRecoveredProvisioning(...input))],
    [threadControlApprovalWriteOperations.settle.name, databaseWriteHandler(threadControlApprovalWriteOperations.settle, (input) => store.settle(...input))],
    [threadControlApprovalWriteOperations.requeueDispatch.name, databaseWriteHandler(threadControlApprovalWriteOperations.requeueDispatch, (input) => store.requeueDispatch(...input))],
  ]);
}
