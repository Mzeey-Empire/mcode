import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { ParentAssistantTextCheckpointStore, type ParentAssistantTextCheckpointInput,
  type ParentAssistantTextRecoveryJournalChunk, type ParentAssistantTextRecoveryJournalOptions } from "./parent-assistant-text-checkpoint-store.js";
import { parentAssistantTextWriteOperations } from "./parent-assistant-text-write-operations.js";

export * from "./parent-assistant-text-checkpoint-store.js";

/** Read provisional text on main and commit its mutations through the application writer. */
@injectable()
export class ParentAssistantTextCheckpointService {
  private readonly reader: ParentAssistantTextCheckpointStore;
  constructor(@inject("Database") db: Database,
    @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter,
    @inject("ParentAssistantTextRecoveryJournalOptions", { isOptional: true }) options: ParentAssistantTextRecoveryJournalOptions = {}) {
    this.reader = new ParentAssistantTextCheckpointStore(db, undefined, options);
  }

  /** The filesystem fallback remains available while SQLite writes are delayed. */
  get recoveryJournal() { return this.reader.recoveryJournal; }

  /** Commit one bounded ordered chunk before reporting its durable position. */
  appendChunk(inputs: readonly ParentAssistantTextCheckpointInput[]) {
    return this.writer.execute(parentAssistantTextWriteOperations.appendChunk, [...inputs]);
  }

  /** Commit one validated journal record without removing the source file. */
  appendRecoveredChunk(input: ParentAssistantTextRecoveryJournalChunk) {
    return this.writer.execute(parentAssistantTextWriteOperations.appendRecoveredChunk, input);
  }

  /** Remove recovery journals only after their complete records have committed. */
  importRecoveryJournals(): Promise<string[]> {
    return this.recoveryJournal.drainAllAsync(async (input) => {
      const result = await this.appendRecoveredChunk(input);
      if (result.outcome === "overflow") throw new Error("Assistant text recovery journal exceeds the retained checkpoint capacity");
    });
  }

  /** Restore the exact committed prefix without a storage mutation. */
  restore(executionId: string): string { return this.reader.restore(executionId); }

  /** Restore committed chunks in accepted order. */
  restoreChunks(executionId: string) { return this.reader.restoreChunks(executionId); }

  /** Discard unfinished checkpoint rows before deleting their filesystem fallback. */
  async reset(executionId: string): Promise<boolean> {
    const reset = await this.writer.execute(parentAssistantTextWriteOperations.reset, executionId);
    if (reset) this.discardRecoveryJournal(executionId);
    return reset;
  }

  /** Commit the retry reset before admitting a fresh text generation. */
  async resetForRetry(executionId: string): Promise<boolean> {
    const reset = await this.writer.execute(parentAssistantTextWriteOperations.resetForRetry, executionId);
    if (reset) this.discardRecoveryJournal(executionId);
    return reset;
  }

  /** Delete provisional rows only after the writer verifies a terminal canonical checkpoint. */
  async retire(executionId: string): Promise<boolean> {
    const retired = await this.writer.execute(parentAssistantTextWriteOperations.retire, executionId);
    if (retired) this.discardRecoveryJournal(executionId);
    return retired;
  }

  /** Retire stale checkpoint rows whose canonical execution is already terminal. */
  retireTerminalCheckpoints(): Promise<number> {
    return this.writer.execute(parentAssistantTextWriteOperations.retireTerminalCheckpoints, undefined);
  }

  /** Remove a journal after its equivalent canonical projection has committed. */
  discardRecoveryJournal(executionId: string): void { this.reader.discardRecoveryJournal(executionId); }
}
