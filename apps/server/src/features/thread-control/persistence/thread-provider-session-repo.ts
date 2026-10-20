import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { ThreadProviderSessionStore } from "./thread-provider-session-store.js";
import type { ThreadProviderSession, UpsertThreadProviderSessionInput } from "./thread-provider-session-store.js";
import { threadProviderSessionWriteOperations } from "./thread-provider-session-write-operations.js";
export type { ThreadProviderSession, UpsertThreadProviderSessionInput } from "./thread-provider-session-store.js";

/**
 * Which native session each provider holds on a thread, and how far into the thread it has seen.
 * Reads use the shared connection; writes commit through the application writer.
 */
@injectable()
export class ThreadProviderSessionRepo {
  private readonly reader: ThreadProviderSessionStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ThreadProviderSessionStore(db);
  }

  /** Return the provider's session on the thread, or null when it never ran there. */
  find(threadId: string, providerId: string): ThreadProviderSession | null {
    return this.reader.find(threadId, providerId);
  }

  /** Return every provider session on the thread. */
  listForThread(threadId: string): ThreadProviderSession[] {
    return this.reader.listForThread(threadId);
  }

  /** Insert the provider's session or replace the one already recorded for it. */
  upsert(input: UpsertThreadProviderSessionInput): Promise<void> {
    return this.writer.execute(threadProviderSessionWriteOperations.upsert, [input]);
  }

  /** Advance the provider's watermark after a turn it ran. No-op when the provider has no row. */
  markSeen(threadId: string, providerId: string, lastSeenSequence: number): Promise<void> {
    return this.writer.execute(threadProviderSessionWriteOperations.markSeen, [threadId, providerId, lastSeenSequence]);
  }

  /** Forget the provider's session on the thread. Other providers' sessions stay. */
  remove(threadId: string, providerId: string): Promise<void> {
    return this.writer.execute(threadProviderSessionWriteOperations.remove, [threadId, providerId]);
  }
}
