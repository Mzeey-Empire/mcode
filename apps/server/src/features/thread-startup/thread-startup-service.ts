import { inject, injectable } from "tsyringe";
import type { Thread, ThreadStartup, ThreadStartupStartInput } from "@mcode/contracts";
import { broadcast } from "../../application/transport/push.js";
import { ApplicationDatabaseWriter } from "../../runtime/persistence/sqlite/application-database-writer.js";
import type { DatabaseWriteOperation } from "../../runtime/persistence/sqlite/database-write-operation.js";
import { ThreadStartupRepo } from "./persistence/thread-startup-repo.js";
import {
  ThreadStartupConflictError,
  type ThreadStartupStateStore,
  type ThreadStartupThreadCreation,
} from "./thread-startup-state-store.js";
import {
  threadStartupStateWriteOperations,
  type ThreadStartupCommittedTransition,
} from "./thread-startup-state-write-operations.js";

export { ThreadStartupConflictError };
export type { ThreadStartupThreadCreation };

/** Publishes startup snapshots only after their complete transition commits. */
@injectable()
export class ThreadStartupService {
  constructor(
    @inject(ThreadStartupRepo) private readonly startupRepo: ThreadStartupRepo,
    @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Start a lifecycle or return its existing snapshot when the request matches. */
  async start(input: ThreadStartupStartInput, requestFingerprint?: string): Promise<ThreadStartup> {
    try {
      return await this.commit(threadStartupStateWriteOperations.start, [[input, requestFingerprint], this.timestamp()]);
    } catch (error) {
      this.rethrowConflict(error, input.startupId);
    }
  }

  /** Create and bind a thread in one worker-owned SQLite commit. */
  async createAndBindThread(startupId: string, input: ThreadStartupThreadCreation): Promise<Thread> {
    try {
      const committed = await this.writer.execute(threadStartupStateWriteOperations.createAndBindThread, [startupId, input, this.timestamp()]);
      if (committed.changed) broadcast("thread.startup.updated", committed.startup);
      return committed.thread;
    } catch (error) {
      this.rethrowConflict(error, startupId);
    }
  }

  /** Read one authoritative lifecycle snapshot. */
  get(startupId: string): ThreadStartup | null {
    return this.startupRepo.findById(startupId);
  }

  /** List authoritative lifecycle snapshots for a workspace. */
  list(workspaceId: string): ThreadStartup[] {
    return this.startupRepo.listByWorkspace(workspaceId);
  }

  /** Find the active or newest terminal startup associated with a thread. */
  findByThreadId(threadId: string): ThreadStartup | null {
    return this.startupRepo.findByThreadId(threadId);
  }

  /** Mark the current phase active or move to the next phase. */
  advance(...[startupId, phase, detail]: Parameters<ThreadStartupStateStore["advance"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.advance, [[startupId, phase, detail], this.timestamp()]);
  }

  /** Bind the durable identity when a flow creates or reuses a thread. */
  bindThread(...input: Parameters<ThreadStartupStateStore["bindThread"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.bindThread, [input, this.timestamp()]);
  }

  /** Remove a binding after its owning flow confirms child deletion. */
  clearThreadBinding(...input: Parameters<ThreadStartupStateStore["clearThreadBinding"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.clearThreadBinding, [input, this.timestamp()]);
  }

  /** Retain one bounded output entry in the startup transcript. */
  appendOutput(...input: Parameters<ThreadStartupStateStore["appendOutput"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.appendOutput, [input, this.timestamp()]);
  }

  /** Complete the final phase and make the lifecycle terminal. */
  complete(...input: Parameters<ThreadStartupStateStore["complete"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.complete, [input, this.timestamp()]);
  }

  /** Keep the current phase blocked until the user retries or continues. */
  block(...[startupId, block, detail]: Parameters<ThreadStartupStateStore["block"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.block, [[startupId, block, detail], this.timestamp()]);
  }

  /** Resume the current blocked or interrupted phase. */
  resume(...input: Parameters<ThreadStartupStateStore["resume"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.resume, [input, this.timestamp()]);
  }

  /** Skip the recoverable phase and enter the next phase. */
  skip(...[startupId, phase, detail]: Parameters<ThreadStartupStateStore["skip"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.skip, [[startupId, phase, detail], this.timestamp()]);
  }

  /** Fail the active phase with its durable error. */
  fail(...[startupId, error, detail]: Parameters<ThreadStartupStateStore["fail"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.fail, [[startupId, error, detail], this.timestamp()]);
  }

  /** Persist cancellation intent before the owning flow stops its work. */
  cancel(...input: Parameters<ThreadStartupStateStore["cancel"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.cancel, [input, this.timestamp()]);
  }

  /** Acknowledge cancellation after the owning flow has stopped. */
  markCancelled(...input: Parameters<ThreadStartupStateStore["markCancelled"]>): Promise<ThreadStartup> {
    return this.commit(threadStartupStateWriteOperations.markCancelled, [input, this.timestamp()]);
  }

  /** Read cancellation intent without issuing a write. */
  isCancellationRequested(startupId: string): boolean {
    const startup = this.startupRepo.findById(startupId);
    if (!startup) throw new Error(`Startup ${startupId} was not found`);
    return startup.cancellation === "requested";
  }

  /** List interrupted snapshots for restart recovery. */
  listInterrupted(): ThreadStartup[] {
    return this.startupRepo.listInterrupted();
  }

  /** Recover interrupted process work in bounded worker commands. */
  async interruptNonterminalOnStartup(): Promise<ThreadStartup[]> {
    const interrupted: ThreadStartup[] = [];
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.writer.execute(threadStartupStateWriteOperations.interruptBatch, [cursor, this.timestamp()]);
      for (const startup of batch.records) broadcast("thread.startup.updated", startup);
      interrupted.push(...batch.records);
      if (batch.nextCursor === null) return interrupted;
      cursor = batch.nextCursor;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async commit<Input>(operation: DatabaseWriteOperation<Input, ThreadStartupCommittedTransition>, input: Input): Promise<ThreadStartup> {
    const committed = await this.writer.execute(operation, input);
    if (committed.changed) broadcast("thread.startup.updated", committed.startup);
    return committed.startup;
  }

  private rethrowConflict(error: unknown, startupId: string): never {
    if (error instanceof Error && error.name === "ThreadStartupConflictError") throw new ThreadStartupConflictError(startupId);
    throw error;
  }
}
