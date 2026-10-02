import { z } from "zod";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Question-answer persistence admitted to the shared owner. */
export const planQuestionAnswersWriteOperations = {
  markAnswered: databaseWriteOperation("planQuestionAnswers.markAnswered", z.tuple([z.string(), z.string()]), z.void()),
};
