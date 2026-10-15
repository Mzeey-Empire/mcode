import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { PlanQuestionAnswersStore } from "./plan-question-answers-store.js";
import { planQuestionAnswersWriteOperations } from "./plan-question-answers-write-operations.js";

/** Read-only queries and committed mutations for PlanQuestionAnswersRepo. */
@injectable()
export class PlanQuestionAnswersRepo {
  private readonly reader: PlanQuestionAnswersStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new PlanQuestionAnswersStore(db);
  }

  markAnswered(assistantMessageId: Parameters<PlanQuestionAnswersStore["markAnswered"]>[0], threadId: Parameters<PlanQuestionAnswersStore["markAnswered"]>[1]): Promise<ReturnType<PlanQuestionAnswersStore["markAnswered"]>> {
    return this.writer.execute(planQuestionAnswersWriteOperations.markAnswered, [assistantMessageId, threadId]);
  }

  /** Publish only after the sole writer has saved this native batch. */
  createNative(batch: Parameters<PlanQuestionAnswersStore["createNative"]>[0]): Promise<void> {
    return this.writer.execute(planQuestionAnswersWriteOperations.createNative, batch);
  }

  /** Retire a native request and its dock through the sole writer. */
  settleNative(batch: Parameters<PlanQuestionAnswersStore["settleNative"]>[0], status: Parameters<PlanQuestionAnswersStore["settleNative"]>[1]): Promise<ReturnType<PlanQuestionAnswersStore["settleNative"]>> {
    return this.writer.execute(planQuestionAnswersWriteOperations.settleNative, { batch, status });
  }

  /** Stored native batches whose connection has not been settled. */
  pendingNative(threadId?: string) {
    return this.reader.pendingNative(threadId);
  }

  isAnswered(assistantMessageId: Parameters<PlanQuestionAnswersStore["isAnswered"]>[0]): ReturnType<PlanQuestionAnswersStore["isAnswered"]> {
    return this.reader.isAnswered(assistantMessageId);
  }

  listAnsweredForThread(threadId: Parameters<PlanQuestionAnswersStore["listAnsweredForThread"]>[0]): ReturnType<PlanQuestionAnswersStore["listAnsweredForThread"]> {
    return this.reader.listAnsweredForThread(threadId);
  }
}
