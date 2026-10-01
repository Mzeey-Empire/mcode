import type { CreateToolCallRecordInput } from "./tool-call-record-store.js";
import { commitNarrativeBatches } from "../../conversation/narrative/persistence/narrative-write-batches.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS, type WriteBatchLimits, type WriteBatchResult } from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { ToolCallRecordStore } from "./tool-call-record-store.js";
import { toolCallRecordWriteOperations } from "./tool-call-record-write-operations.js";
export type { CreateToolCallRecordInput } from "./tool-call-record-store.js";

/** Read-only queries and committed mutations for ToolCallRecordRepo. */
@injectable()
export class ToolCallRecordRepo {
  private readonly reader: ToolCallRecordStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ToolCallRecordStore(db);
  }

  create(input: Parameters<ToolCallRecordStore["create"]>[0]): Promise<ReturnType<ToolCallRecordStore["create"]>> {
    return this.writer.execute(toolCallRecordWriteOperations.create, [input]);
  }

  bulkCreate(inputs: Parameters<ToolCallRecordStore["bulkCreate"]>[0], replaceExisting: Parameters<ToolCallRecordStore["bulkCreate"]>[1] = false): Promise<ReturnType<ToolCallRecordStore["bulkCreate"]>> {
    return this.writer.execute(toolCallRecordWriteOperations.bulkCreate, [inputs, replaceExisting]);
  }

  listByMessage(messageId: Parameters<ToolCallRecordStore["listByMessage"]>[0]): ReturnType<ToolCallRecordStore["listByMessage"]> {
    return this.reader.listByMessage(messageId);
  }

  updateSubagentIdentity(toolCallId: Parameters<ToolCallRecordStore["updateSubagentIdentity"]>[0], messageId: Parameters<ToolCallRecordStore["updateSubagentIdentity"]>[1], subagentIdentityKey: Parameters<ToolCallRecordStore["updateSubagentIdentity"]>[2]): Promise<ReturnType<ToolCallRecordStore["updateSubagentIdentity"]>> {
    return this.writer.execute(toolCallRecordWriteOperations.updateSubagentIdentity, [toolCallId, messageId, subagentIdentityKey]);
  }

  listByMessages(messageIds: Parameters<ToolCallRecordStore["listByMessages"]>[0]): ReturnType<ToolCallRecordStore["listByMessages"]> {
    return this.reader.listByMessages(messageIds);
  }

  listByParent(parentToolCallId: Parameters<ToolCallRecordStore["listByParent"]>[0]): ReturnType<ToolCallRecordStore["listByParent"]> {
    return this.reader.listByParent(parentToolCallId);
  }

  countByMessage(messageId: Parameters<ToolCallRecordStore["countByMessage"]>[0]): ReturnType<ToolCallRecordStore["countByMessage"]> {
    return this.reader.countByMessage(messageId);
  }
  /** Await bounded commands and continue from their committed prefixes. */
  bulkCreateBatched(inputs: readonly CreateToolCallRecordInput[], limits: WriteBatchLimits = ACTIVE_TURN_WRITE_BATCH_LIMITS, replaceExisting = false): Promise<WriteBatchResult> {
    return commitNarrativeBatches(this.writer, toolCallRecordWriteOperations.createBoundedBatch, inputs, limits, replaceExisting);
  }
}
