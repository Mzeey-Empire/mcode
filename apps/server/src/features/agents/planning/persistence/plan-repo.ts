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

  create(threadId: Parameters<PlanStore["create"]>[0], messageId: Parameters<PlanStore["create"]>[1], title: Parameters<PlanStore["create"]>[2], contentMd: Parameters<PlanStore["create"]>[3], sectionsJson: Parameters<PlanStore["create"]>[4], changeSummary: Parameters<PlanStore["create"]>[5]): Promise<ReturnType<PlanStore["create"]>> {
    return this.writer.execute(planWriteOperations.create, [threadId, messageId, title, contentMd, sectionsJson, changeSummary]);
  }

  updateStatus(planId: Parameters<PlanStore["updateStatus"]>[0], status: Parameters<PlanStore["updateStatus"]>[1]): Promise<ReturnType<PlanStore["updateStatus"]>> {
    return this.writer.execute(planWriteOperations.updateStatus, [planId, status]);
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
