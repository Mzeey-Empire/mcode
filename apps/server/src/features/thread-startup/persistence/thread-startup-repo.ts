import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { ThreadStartupStore } from "./thread-startup-store.js";
import { threadStartupWriteOperations } from "./thread-startup-write-operations.js";

/** Read-only queries and committed mutations for ThreadStartupRepo. */
@injectable()
export class ThreadStartupRepo {
  private readonly reader: ThreadStartupStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ThreadStartupStore(db);
  }

  insert(startup: Parameters<ThreadStartupStore["insert"]>[0], requestFingerprint?: Parameters<ThreadStartupStore["insert"]>[1]): Promise<ReturnType<ThreadStartupStore["insert"]>> {
    return this.writer.execute(threadStartupWriteOperations.insert, [startup, requestFingerprint]);
  }

  requestFingerprint(startupId: Parameters<ThreadStartupStore["requestFingerprint"]>[0]): ReturnType<ThreadStartupStore["requestFingerprint"]> {
    return this.reader.requestFingerprint(startupId);
  }

  findById(startupId: Parameters<ThreadStartupStore["findById"]>[0]): ReturnType<ThreadStartupStore["findById"]> {
    return this.reader.findById(startupId);
  }

  listByWorkspace(workspaceId: Parameters<ThreadStartupStore["listByWorkspace"]>[0], limit: Parameters<ThreadStartupStore["listByWorkspace"]>[1] = 100): ReturnType<ThreadStartupStore["listByWorkspace"]> {
    return this.reader.listByWorkspace(workspaceId, limit);
  }

  listInterruptible(): ReturnType<ThreadStartupStore["listInterruptible"]> {
    return this.reader.listInterruptible();
  }

  interruptibleBatch(afterStartupId?: Parameters<ThreadStartupStore["interruptibleBatch"]>[0]): ReturnType<ThreadStartupStore["interruptibleBatch"]> {
    return this.reader.interruptibleBatch(afterStartupId);
  }

  listInterrupted(): ReturnType<ThreadStartupStore["listInterrupted"]> {
    return this.reader.listInterrupted();
  }

  findByThreadId(threadId: Parameters<ThreadStartupStore["findByThreadId"]>[0]): ReturnType<ThreadStartupStore["findByThreadId"]> {
    return this.reader.findByThreadId(threadId);
  }

  update(startup: Parameters<ThreadStartupStore["update"]>[0]): Promise<ReturnType<ThreadStartupStore["update"]>> {
    return this.writer.execute(threadStartupWriteOperations.update, [startup]);
  }
}
