import { inject, injectable } from "tsyringe";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { conversationConversionWriteOperations } from "./conversation-conversion-write-operations.js";
import type { LegacyConversationMigrationBatchResult } from "./legacy-conversation-migration-store.js";

export {
  LEGACY_CONVERSATION_MIGRATION_VERSION,
  LEGACY_CONVERSATION_MIGRATION_MAX_NARRATIVE_ITEMS,
  LEGACY_CONVERSATION_MIGRATION_MAX_BYTES,
  LEGACY_CONVERSATION_MIGRATION_MAX_LINEAGE_DEPTH,
} from "./legacy-conversation-migration-store.js";
export type { LegacyConversationMigrationBatchResult, LegacyConversationMigrationFailureHooks } from "./legacy-conversation-migration-store.js";

/** Run resumable legacy conversion without mutating the main reader connection. */
@injectable()
export class LegacyConversationMigration {
  constructor(@inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {}

  /** Resolve after one bounded checkpoint commits. */
  runBatch(): Promise<LegacyConversationMigrationBatchResult> {
    return this.writer.execute(conversationConversionWriteOperations.legacyBatch, undefined);
  }

  /** Allow other queued commands between complete durable conversion checkpoints. */
  async runToCompletion(): Promise<LegacyConversationMigrationBatchResult> {
    let result = await this.runBatch();
    while (!result.completed) result = await this.runBatch();
    return result;
  }
}
