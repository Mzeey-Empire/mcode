import type { Database } from "bun:sqlite";
import type { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkspaceEnvironmentAutomaticStore } from "./workspace-environment-automatic-store.js";
import { workspaceEnvironmentAutomaticWriteOperations } from "./workspace-environment-automatic-write-operations.js";
export { WorkspaceEnvironmentAutomaticQueueCapacityError } from "./workspace-environment-automatic-store.js";
export type { WorkspaceEnvironmentQueuedTurnSubmission, WorkspaceEnvironmentQueueFirstTurnInput, WorkspaceEnvironmentQueueAdmission, WorkspaceEnvironmentClaimedQueuedTurn } from "./workspace-environment-automatic-store.js";

/** Automatic Setup reads and complete atomic mutations on the shared owner. */
export class WorkspaceEnvironmentAutomaticRepository {
  private readonly reader: WorkspaceEnvironmentAutomaticStore;

  constructor(db: Database, private readonly now: () => string, private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new WorkspaceEnvironmentAutomaticStore(db, now);
  }

  /** Commit queueFirstTurn through its database owner. */
  queueFirstTurn(...input: Parameters<WorkspaceEnvironmentAutomaticStore["queueFirstTurn"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["queueFirstTurn"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.queueFirstTurn, [input, this.now()]);
  }

  /** Read snapshot through its database owner. */
  snapshot(...input: Parameters<WorkspaceEnvironmentAutomaticStore["snapshot"]>): ReturnType<WorkspaceEnvironmentAutomaticStore["snapshot"]> {
    return this.reader.snapshot(...input);
  }

  /** Commit beginAttempt through its database owner. */
  beginAttempt(...input: Parameters<WorkspaceEnvironmentAutomaticStore["beginAttempt"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["beginAttempt"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.beginAttempt, [input, this.now()]);
  }

  /** Commit awaitApproval through its database owner. */
  awaitApproval(...input: Parameters<WorkspaceEnvironmentAutomaticStore["awaitApproval"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["awaitApproval"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.awaitApproval, [input, this.now()]);
  }

  /** Commit resumeAwaitingApproval through its database owner. */
  resumeAwaitingApproval(...input: Parameters<WorkspaceEnvironmentAutomaticStore["resumeAwaitingApproval"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["resumeAwaitingApproval"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.resumeAwaitingApproval, [input, this.now()]);
  }

  /** Commit completeAttempt through its database owner. */
  completeAttempt(...input: Parameters<WorkspaceEnvironmentAutomaticStore["completeAttempt"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["completeAttempt"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.completeAttempt, [input, this.now()]);
  }

  /** Commit failQueuedAttempt through its database owner. */
  failQueuedAttempt(...input: Parameters<WorkspaceEnvironmentAutomaticStore["failQueuedAttempt"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["failQueuedAttempt"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.failQueuedAttempt, [input, this.now()]);
  }

  /** Commit releaseWithoutSetup through its database owner. */
  releaseWithoutSetup(...input: Parameters<WorkspaceEnvironmentAutomaticStore["releaseWithoutSetup"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["releaseWithoutSetup"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.releaseWithoutSetup, [input, this.now()]);
  }

  /** Commit continueWithoutSetup through its database owner. */
  continueWithoutSetup(...input: Parameters<WorkspaceEnvironmentAutomaticStore["continueWithoutSetup"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["continueWithoutSetup"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.continueWithoutSetup, [input, this.now()]);
  }

  /** Commit cancelQueuedTurn through its database owner. */
  cancelQueuedTurn(...input: Parameters<WorkspaceEnvironmentAutomaticStore["cancelQueuedTurn"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["cancelQueuedTurn"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.cancelQueuedTurn, [input, this.now()]);
  }

  /** Commit interruptCurrentAttempt through its database owner. */
  interruptCurrentAttempt(...input: Parameters<WorkspaceEnvironmentAutomaticStore["interruptCurrentAttempt"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["interruptCurrentAttempt"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.interruptCurrentAttempt, [input, this.now()]);
  }

  /** Commit retryCurrentAttempt through its database owner. */
  retryCurrentAttempt(...input: Parameters<WorkspaceEnvironmentAutomaticStore["retryCurrentAttempt"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["retryCurrentAttempt"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.retryCurrentAttempt, [input, this.now()]);
  }

  /** Commit interruptUnfinishedAttempts through its database owner. */
  interruptUnfinishedAttempts(...input: Parameters<WorkspaceEnvironmentAutomaticStore["interruptUnfinishedAttempts"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["interruptUnfinishedAttempts"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.interruptUnfinishedAttempts, [input, this.now()]);
  }

  /** Commit claimReleasedTurn through its database owner. */
  claimReleasedTurn(...input: Parameters<WorkspaceEnvironmentAutomaticStore["claimReleasedTurn"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["claimReleasedTurn"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.claimReleasedTurn, [input, this.now()]);
  }

  /** Read releasedThreadIds through its database owner. */
  releasedThreadIds(...input: Parameters<WorkspaceEnvironmentAutomaticStore["releasedThreadIds"]>): ReturnType<WorkspaceEnvironmentAutomaticStore["releasedThreadIds"]> {
    return this.reader.releasedThreadIds(...input);
  }

  /** Commit markDispatched through its database owner. */
  markDispatched(...input: Parameters<WorkspaceEnvironmentAutomaticStore["markDispatched"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["markDispatched"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.markDispatched, [input, this.now()]);
  }
}
