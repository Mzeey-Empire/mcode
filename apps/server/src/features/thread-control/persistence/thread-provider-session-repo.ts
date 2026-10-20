import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { ThreadProviderSessionStore } from "./thread-provider-session-store.js";
import type { ResolvedProviderSession, ThreadProviderSession, UpsertThreadProviderSessionInput } from "./thread-provider-session-store.js";
import { threadProviderSessionWriteOperations } from "./thread-provider-session-write-operations.js";
export type { ResolvedProviderSession, ThreadProviderSession, UpsertThreadProviderSessionInput } from "./thread-provider-session-store.js";

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

  /**
   * Resolve the session the provider would resume on the thread, with the sequence it has seen through.
   * The thread's current provider always resolves to `threads.sdk_session_id`; see the store for why.
   */
  resolve(threadId: string, providerId: string): ResolvedProviderSession | null {
    return this.reader.resolve(threadId, providerId);
  }

  /** Return every provider session on the thread. */
  listForThread(threadId: string): ThreadProviderSession[] {
    return this.reader.listForThread(threadId);
  }

  /** Insert the provider's session or replace the one already recorded for it. */
  upsert(input: UpsertThreadProviderSessionInput): Promise<void> {
    return this.writer.execute(threadProviderSessionWriteOperations.upsert, [input]);
  }

  /**
   * Advance the watermark of the session a finished turn ran on, to that turn's own last message
   * sequence. No-op when the provider's row names another session.
   */
  markSeen(threadId: string, providerId: string, sessionId: string, lastSeenSequence: number): Promise<void> {
    return this.writer.execute(threadProviderSessionWriteOperations.markSeen, [threadId, providerId, sessionId, lastSeenSequence]);
  }

  /** Forget the provider's session on the thread. Other providers' sessions stay. */
  remove(threadId: string, providerId: string): Promise<void> {
    return this.writer.execute(threadProviderSessionWriteOperations.remove, [threadId, providerId]);
  }
}
