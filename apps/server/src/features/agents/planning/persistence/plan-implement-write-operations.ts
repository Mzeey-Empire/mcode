import { z } from "zod";
import { NativePlanFileOutcomeSchema, NativePlanFileRefSchema, PlanImplementErrorSchema,
  PlanImplementSchema, PlanImplementTargetSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Persisted Implement snapshot shared across the writer boundary. */
export const PlanImplementRequestSchema = z.object({
  requestId: z.string().uuid(), sourceThreadId: z.string(), fingerprint: z.string(),
  versionId: z.string().uuid(), version: z.number().int(), revision: z.number().int(), title: z.string(),
  wireText: z.string(), target: PlanImplementTargetSchema(), sourceCommit: z.string().nullable(),
  targetThreadId: z.string().nullable(), startupId: z.string().nullable(), messageId: z.string().uuid(),
  status: z.enum(["preparing", "admitted", "failed"]), failureCode: z.string().nullable(),
  nativePlanFile: NativePlanFileOutcomeSchema().nullable(), turnId: z.string().nullable(), executionId: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});

/** A request row is authoritative even when the caller loses the admission response. */
export type PlanImplementRequest = z.infer<typeof PlanImplementRequestSchema>;

const prepareResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), request: PlanImplementRequestSchema, contentMd: z.string(),
    nativePlanFile: NativePlanFileRefSchema().nullable() }),
  PlanImplementErrorSchema().extend({ ok: z.literal(false) }),
]);

/** Result of the all-or-nothing pending save and request preparation. */
export type PlanImplementPrepareResult = z.infer<typeof prepareResult>;

/** Serialized Implement operations; acceptance belongs to canonical parent start. */
export const planImplementWriteOperations = {
  prepare: databaseWriteOperation("plan.implement.prepare", z.object({ input: PlanImplementSchema(),
    fingerprint: z.string(), planFilePath: z.string() }), prepareResult),
  read: databaseWriteOperation("plan.implement.read", z.string().uuid(), PlanImplementRequestSchema.nullable()),
  nativeFile: databaseWriteOperation("plan.implement.nativeFile", z.object({ requestId: z.string().uuid(),
    outcome: NativePlanFileOutcomeSchema() }), z.void()),
  fail: databaseWriteOperation("plan.implement.fail", z.object({ requestId: z.string().uuid(), code: z.string() }),
    PlanImplementRequestSchema.nullable()),
  preparing: databaseWriteOperation("plan.implement.preparing", z.object({}), z.array(PlanImplementRequestSchema)),
};
