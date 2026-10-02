import { inject, injectable } from "tsyringe";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import type { ThreadControlAuditStore } from "./thread-control-audit-store.js";
import { threadControlAuditWriteOperations } from "./thread-control-audit-write-operations.js";

/** Read-only queries and committed mutations for ThreadControlAuditRepo. */
@injectable()
export class ThreadControlAuditRepo {
  constructor(@inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {}

  write(input: Parameters<ThreadControlAuditStore["write"]>[0]): Promise<ReturnType<ThreadControlAuditStore["write"]>> {
    return this.writer.execute(threadControlAuditWriteOperations.write, [input]);
  }
}
