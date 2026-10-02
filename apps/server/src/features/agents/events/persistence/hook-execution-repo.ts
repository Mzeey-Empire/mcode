import type { CreateHookExecutionInput } from "./hook-execution-store.js";
import { commitNarrativeBatches } from "../../conversation/narrative/persistence/narrative-write-batches.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS, type WriteBatchLimits, type WriteBatchResult } from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { HookExecutionStore } from "./hook-execution-store.js";
import { hookExecutionWriteOperations } from "./hook-execution-write-operations.js";
export type { CreateHookExecutionInput } from "./hook-execution-store.js";

/** Read-only queries and committed mutations for HookExecutionRepo. */
@injectable()
export class HookExecutionRepo {
  private readonly reader: HookExecutionStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new HookExecutionStore(db);
  }

  create(input: Parameters<HookExecutionStore["create"]>[0]): Promise<ReturnType<HookExecutionStore["create"]>> {
    return this.writer.execute(hookExecutionWriteOperations.create, [input]);
  }

  bulkCreate(inputs: Parameters<HookExecutionStore["bulkCreate"]>[0], replaceExisting: Parameters<HookExecutionStore["bulkCreate"]>[1] = false): Promise<ReturnType<HookExecutionStore["bulkCreate"]>> {
    return this.writer.execute(hookExecutionWriteOperations.bulkCreate, [inputs, replaceExisting]);
  }

  listByMessage(messageId: Parameters<HookExecutionStore["listByMessage"]>[0]): ReturnType<HookExecutionStore["listByMessage"]> {
    return this.reader.listByMessage(messageId);
  }

  listByMessages(messageIds: Parameters<HookExecutionStore["listByMessages"]>[0]): ReturnType<HookExecutionStore["listByMessages"]> {
    return this.reader.listByMessages(messageIds);
  }

  countByMessage(messageId: Parameters<HookExecutionStore["countByMessage"]>[0]): ReturnType<HookExecutionStore["countByMessage"]> {
    return this.reader.countByMessage(messageId);
  }
  /** Await bounded commands and continue from their committed prefixes. */
  bulkCreateBatched(inputs: readonly CreateHookExecutionInput[], limits: WriteBatchLimits = ACTIVE_TURN_WRITE_BATCH_LIMITS, replaceExisting = false): Promise<WriteBatchResult> {
    return commitNarrativeBatches(this.writer, hookExecutionWriteOperations.createBoundedBatch, inputs, limits, replaceExisting);
  }
}
