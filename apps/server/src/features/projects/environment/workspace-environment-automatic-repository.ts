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

  /** Commit the startup action projection and attempt as one transition. */
  transitionStartupActions(...input: Parameters<WorkspaceEnvironmentAutomaticStore["transitionStartupActions"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["transitionStartupActions"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.transitionStartupActions, [input, this.now()]);
  }

  /** Commit releaseWithoutSetup through its database owner. */
  releaseWithoutSetup(...input: Parameters<WorkspaceEnvironmentAutomaticStore["releaseWithoutSetup"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["releaseWithoutSetup"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.releaseWithoutSetup, [input, this.now()]);
  }

  /** Commit continueWithoutSetup through its database owner. */
  continueWithoutSetup(...input: Parameters<WorkspaceEnvironmentAutomaticStore["continueWithoutSetup"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["continueWithoutSetup"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.continueWithoutSetup, [input, this.now()]);
  }

  /** Discard a cancelled startup's pending Turns and gate in one writer transaction. */
  cancelStartupTurns(threadId: string): Promise<void> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.cancelStartupTurns, [[threadId], this.now()]);
  }

  /** Commit interruptCurrentAttempt through its database owner. */
  interruptCurrentAttempt(...input: Parameters<WorkspaceEnvironmentAutomaticStore["interruptCurrentAttempt"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["interruptCurrentAttempt"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.interruptCurrentAttempt, [input, this.now()]);
  }

  /** Commit retryCurrentAttempt through its database owner. */
  retryCurrentAttempt(...input: Parameters<WorkspaceEnvironmentAutomaticStore["retryCurrentAttempt"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["retryCurrentAttempt"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.retryCurrentAttempt, [input, this.now()]);
  }

  /** Commit releaseUnsentClaim through its database owner. */
  releaseUnsentClaim(...input: Parameters<WorkspaceEnvironmentAutomaticStore["releaseUnsentClaim"]>): Promise<ReturnType<WorkspaceEnvironmentAutomaticStore["releaseUnsentClaim"]>> {
    return this.writer.execute(workspaceEnvironmentAutomaticWriteOperations.releaseUnsentClaim, [input, this.now()]);
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
