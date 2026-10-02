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

  isAnswered(assistantMessageId: Parameters<PlanQuestionAnswersStore["isAnswered"]>[0]): ReturnType<PlanQuestionAnswersStore["isAnswered"]> {
    return this.reader.isAnswered(assistantMessageId);
  }

  listAnsweredForThread(threadId: Parameters<PlanQuestionAnswersStore["listAnsweredForThread"]>[0]): ReturnType<PlanQuestionAnswersStore["listAnsweredForThread"]> {
    return this.reader.listAnsweredForThread(threadId);
  }
}
