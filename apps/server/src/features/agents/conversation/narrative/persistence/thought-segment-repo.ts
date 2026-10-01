import type { CreateThoughtSegmentInput } from "./thought-segment-store.js";
import { commitNarrativeBatches } from "./narrative-write-batches.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS, type WriteBatchLimits, type WriteBatchResult } from "../../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../../runtime/persistence/sqlite/application-database-writer.js";
import { ThoughtSegmentStore } from "./thought-segment-store.js";
import { thoughtSegmentWriteOperations } from "./thought-segment-write-operations.js";
export type { CreateThoughtSegmentInput } from "./thought-segment-store.js";

/** Read-only queries and committed mutations for ThoughtSegmentRepo. */
@injectable()
export class ThoughtSegmentRepo {
  private readonly reader: ThoughtSegmentStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ThoughtSegmentStore(db);
  }

  create(input: Parameters<ThoughtSegmentStore["create"]>[0]): Promise<ReturnType<ThoughtSegmentStore["create"]>> {
    return this.writer.execute(thoughtSegmentWriteOperations.create, [input]);
  }

  bulkCreate(inputs: Parameters<ThoughtSegmentStore["bulkCreate"]>[0], replaceExisting: Parameters<ThoughtSegmentStore["bulkCreate"]>[1] = false): Promise<ReturnType<ThoughtSegmentStore["bulkCreate"]>> {
    return this.writer.execute(thoughtSegmentWriteOperations.bulkCreate, [inputs, replaceExisting]);
  }

  listByMessage(messageId: Parameters<ThoughtSegmentStore["listByMessage"]>[0]): ReturnType<ThoughtSegmentStore["listByMessage"]> {
    return this.reader.listByMessage(messageId);
  }

  listByMessages(messageIds: Parameters<ThoughtSegmentStore["listByMessages"]>[0]): ReturnType<ThoughtSegmentStore["listByMessages"]> {
    return this.reader.listByMessages(messageIds);
  }

  countByMessage(messageId: Parameters<ThoughtSegmentStore["countByMessage"]>[0]): ReturnType<ThoughtSegmentStore["countByMessage"]> {
    return this.reader.countByMessage(messageId);
  }
  /** Await bounded commands and continue from their committed prefixes. */
  bulkCreateBatched(inputs: readonly CreateThoughtSegmentInput[], limits: WriteBatchLimits = ACTIVE_TURN_WRITE_BATCH_LIMITS, replaceExisting = false): Promise<WriteBatchResult> {
    return commitNarrativeBatches(this.writer, thoughtSegmentWriteOperations.createBoundedBatch, inputs, limits, replaceExisting);
  }
}
