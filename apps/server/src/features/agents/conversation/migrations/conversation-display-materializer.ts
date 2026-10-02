import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { conversationConversionWriteOperations } from "./conversation-conversion-write-operations.js";

/** Materialize canonical display rows through bounded writer-owned checkpoints. */
export class ConversationDisplayMaterializer {
  constructor(private readonly writer: ApplicationDatabaseWriter) {}

  /** Resolve after one bounded checkpoint commits; true means conversion is complete. */
  runBatch(): Promise<boolean> {
    return this.writer.execute(conversationConversionWriteOperations.displayBatch, undefined);
  }

  /** Complete startup conversion without holding the writer across checkpoints. */
  async runToCompletion(): Promise<void> {
    let complete = await this.runBatch();
    while (!complete) complete = await this.runBatch();
  }
}
