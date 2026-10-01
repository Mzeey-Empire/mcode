import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { ThreadControlApprovalStore } from "./thread-control-approval-store.js";
import { threadControlApprovalWriteOperations } from "./thread-control-approval-write-operations.js";
export type { PendingThreadCreateApproval, PendingThreadSendApproval, PendingThreadStopApproval, MalformedThreadCreateApproval, PendingThreadControlApproval, RecoverableThreadCreateApproval, ThreadControlApprovalOperation } from "./thread-control-approval-store.js";

/** Read-only queries and committed mutations for ThreadControlApprovalRepo. */
@injectable()
export class ThreadControlApprovalRepo {
  private readonly reader: ThreadControlApprovalStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ThreadControlApprovalStore(db);
  }

  create(input: Parameters<ThreadControlApprovalStore["create"]>[0]): Promise<ReturnType<ThreadControlApprovalStore["create"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.create, [input]);
  }

  createSend(input: Parameters<ThreadControlApprovalStore["createSend"]>[0]): Promise<ReturnType<ThreadControlApprovalStore["createSend"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.createSend, [input]);
  }

  createStop(input: Parameters<ThreadControlApprovalStore["createStop"]>[0]): Promise<ReturnType<ThreadControlApprovalStore["createStop"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.createStop, [input]);
  }

  claim(approvalId: Parameters<ThreadControlApprovalStore["claim"]>[0]): Promise<ReturnType<ThreadControlApprovalStore["claim"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.claim, [approvalId]);
  }

  setOperationPhase(approvalId: Parameters<ThreadControlApprovalStore["setOperationPhase"]>[0], phase: Parameters<ThreadControlApprovalStore["setOperationPhase"]>[1]): Promise<ReturnType<ThreadControlApprovalStore["setOperationPhase"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.setOperationPhase, [approvalId, phase]);
  }

  listProcessing(): ReturnType<ThreadControlApprovalStore["listProcessing"]> {
    return this.reader.listProcessing();
  }

  requeue(approvalId: Parameters<ThreadControlApprovalStore["requeue"]>[0]): Promise<ReturnType<ThreadControlApprovalStore["requeue"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.requeue, [approvalId]);
  }

  requeueRecoveredProvisioning(approvalId: Parameters<ThreadControlApprovalStore["requeueRecoveredProvisioning"]>[0]): Promise<ReturnType<ThreadControlApprovalStore["requeueRecoveredProvisioning"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.requeueRecoveredProvisioning, [approvalId]);
  }

  settle(approvalId: Parameters<ThreadControlApprovalStore["settle"]>[0], status: Parameters<ThreadControlApprovalStore["settle"]>[1]): Promise<ReturnType<ThreadControlApprovalStore["settle"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.settle, [approvalId, status]);
  }

  listPendingByThread(threadId: Parameters<ThreadControlApprovalStore["listPendingByThread"]>[0]): ReturnType<ThreadControlApprovalStore["listPendingByThread"]> {
    return this.reader.listPendingByThread(threadId);
  }

  listPendingBySourceThread(sourceThreadId: Parameters<ThreadControlApprovalStore["listPendingBySourceThread"]>[0]): ReturnType<ThreadControlApprovalStore["listPendingBySourceThread"]> {
    return this.reader.listPendingBySourceThread(sourceThreadId);
  }

  listPending(): ReturnType<ThreadControlApprovalStore["listPending"]> {
    return this.reader.listPending();
  }

  requeueDispatch(approvalId: Parameters<ThreadControlApprovalStore["requeueDispatch"]>[0]): Promise<ReturnType<ThreadControlApprovalStore["requeueDispatch"]>> {
    return this.writer.execute(threadControlApprovalWriteOperations.requeueDispatch, [approvalId]);
  }
}
