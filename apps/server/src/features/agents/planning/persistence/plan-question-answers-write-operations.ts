import { z } from "zod";
import { MessageSchema } from "@mcode/contracts/models/message";
import { NativePlanQuestionBatchSchema } from "@mcode/contracts/models/plan-questions";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Question-answer persistence admitted to the shared owner. */
export const planQuestionAnswersWriteOperations = {
  createNative: databaseWriteOperation("planQuestionAnswers.createNative", NativePlanQuestionBatchSchema(), z.void()),
  settleNative: databaseWriteOperation("planQuestionAnswers.settleNative", z.object({
    batch: NativePlanQuestionBatchSchema(), status: z.enum(["answered", "dismissed", "expired"]),
  }), MessageSchema().nullable()),
  markAnswered: databaseWriteOperation("planQuestionAnswers.markAnswered", z.tuple([z.string(), z.string()]), z.void()),
};
