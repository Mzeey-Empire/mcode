import { z } from "zod";
import { MessageSchema, NativePlanQuestionBatchSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Question-answer persistence admitted to the shared owner. */
export const planQuestionAnswersWriteOperations = {
  createNative: databaseWriteOperation("planQuestionAnswers.createNative", NativePlanQuestionBatchSchema(), z.void()),
  settleNative: databaseWriteOperation("planQuestionAnswers.settleNative", z.object({
    batch: NativePlanQuestionBatchSchema(), status: z.enum(["answered", "dismissed", "expired"]),
  }), MessageSchema().nullable()),
  markAnswered: databaseWriteOperation("planQuestionAnswers.markAnswered", z.tuple([z.string(), z.string()]), z.void()),
};
