import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { PlanStore } from "./plan-store.js";
import { planWriteOperations } from "./plan-write-operations.js";

/** Read-only queries and committed mutations for PlanRepo. */
@injectable()
export class PlanRepo {
  private readonly reader: PlanStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new PlanStore(db);
  }

  /** Persist a capture through the application writer. */
  create(...input: Parameters<PlanStore["create"]>): Promise<ReturnType<PlanStore["create"]>> {
    return this.writer.execute(planWriteOperations.create, input);
  }

  listByThread(threadId: Parameters<PlanStore["listByThread"]>[0]): ReturnType<PlanStore["listByThread"]> {
    return this.reader.listByThread(threadId);
  }

  getLatestForThread(threadId: Parameters<PlanStore["getLatestForThread"]>[0]): ReturnType<PlanStore["getLatestForThread"]> {
    return this.reader.getLatestForThread(threadId);
  }

  getById(planId: Parameters<PlanStore["getById"]>[0]): ReturnType<PlanStore["getById"]> {
    return this.reader.getById(planId);
  }

  getByMessageId(messageId: Parameters<PlanStore["getByMessageId"]>[0]): ReturnType<PlanStore["getByMessageId"]> {
    return this.reader.getByMessageId(messageId);
  }
}
