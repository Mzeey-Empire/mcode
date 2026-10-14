import { z } from "zod";
import { PlanCommentCreateSchema, PlanCommentDeleteSchema, PlanCommentErrorSchema, PlanCommentSchema,
  PlanCommentSetStatusSchema, PlanCommentUpdateSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

const failure = PlanCommentErrorSchema().extend({ ok: z.literal(false) });
const result = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), comment: PlanCommentSchema() }), failure]);
const deleted = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), threadId: z.string().nullable() }), failure]);

/** Writer results retain domain failures across structured cloning. */
export type PlanCommentWriteResult = z.infer<typeof result>;
/** Deletion includes routing only when a row existed. */
export type PlanCommentDeleteResult = z.infer<typeof deleted>;

/** Allowlisted user comment writes on the sole SQLite writer. */
export const planCommentWriteOperations = {
  create: databaseWriteOperation("plan.comment.create", PlanCommentCreateSchema(), result),
  update: databaseWriteOperation("plan.comment.update", PlanCommentUpdateSchema(), result),
  setStatus: databaseWriteOperation("plan.comment.setStatus", PlanCommentSetStatusSchema(), result),
  delete: databaseWriteOperation("plan.comment.delete", PlanCommentDeleteSchema(), deleted),
};
