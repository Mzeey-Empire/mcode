import { z } from "zod";
import { PlanRecordSchema, PlanStatusSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Plan version allocation and draft replacement commit as one owner command. */
export const planWriteOperations = {
  create: databaseWriteOperation("plan.create", z.tuple([
    z.string(), z.string(), z.string(), z.string(), z.string().nullable(), z.string().nullable(),
  ]), PlanRecordSchema()),
  updateStatus: databaseWriteOperation("plan.updateStatus", z.tuple([z.string(), PlanStatusSchema()]), z.void()),
};
