import { z } from "zod";
import { PlanVersionSchema, PlanSaveVersionSchema, PlanSaveErrorSchema, ProviderIdSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { PlanPersistenceReadySchema } from "../plan-capture-schema.js";

const failure = PlanSaveErrorSchema().extend({ ok: z.literal(false) });
const saveResult = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), version: PlanVersionSchema() }), failure]);
const snapshotResult = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), versions: z.array(PlanVersionSchema()) }), failure]);

/** Cloneable save result preserves typed errors across the worker boundary. */
export type PlanSaveResult = z.infer<typeof saveResult>;
/** Cloneable snapshot result from the serialized writer. */
export type PlanSnapshotResult = z.infer<typeof snapshotResult>;

/** Plan mutations and consistent snapshots share the application's FIFO writer. */
export const planWriteOperations = {
  create: databaseWriteOperation("plan.create", z.tuple([
    z.string(), z.string(), PlanPersistenceReadySchema(), ProviderIdSchema.nullable(),
  ]), PlanVersionSchema()),
  saveVersion: databaseWriteOperation("plan.saveVersion", PlanSaveVersionSchema(), saveResult),
  snapshot: databaseWriteOperation("plan.snapshot", z.object({ threadId: z.string() }), snapshotResult),
};
