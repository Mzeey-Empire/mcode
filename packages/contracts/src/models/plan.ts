import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Lightweight section metadata for TOC navigation (no content body). */
export const PlanSectionNavSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    level: z.number().min(1).max(3),
  }),
);

export type PlanSectionNav = z.infer<ReturnType<typeof PlanSectionNavSchema>>;

/** Plan status lifecycle. */
export const PlanStatusSchema = lazySchema(() =>
  z.enum(["draft", "accepted", "superseded"]),
);

export type PlanStatus = z.infer<ReturnType<typeof PlanStatusSchema>>;

/**
 * Server-side hint for plan-tab actions sent through `agent.send`.
 * Overrides thread interaction mode so implement/revise are not re-wrapped
 * with the plan-questions prompt.
 */
export const PlanActionSchema = lazySchema(() => z.enum(["revise", "implement"]));

export type PlanAction = z.infer<ReturnType<typeof PlanActionSchema>>;

/** A persisted plan record (returned by server to client). */
export const PlanRecordSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    threadId: z.string(),
    messageId: z.string(),
    version: z.number(),
    title: z.string(),
    contentMd: z.string(),
    sectionsJson: z.array(PlanSectionNavSchema()).nullable(),
    changeSummary: z.string().nullable(),
    status: PlanStatusSchema(),
    createdAt: z.string(),
  }),
);

export type PlanRecord = z.infer<ReturnType<typeof PlanRecordSchema>>;

/** Result of reconciling a provider-owned plan file before implementation. */
export const NativePlanFileOutcomeSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.enum(["synced", "deleted"]) }),
    z.object({ outcome: z.literal("skipped"), reason: z.enum(["no-file", "unproven", "changed", "unsafe-path"]) }),
  ]),
);

/** Provider plan-file reconciliation result; paths never cross the client boundary. */
export type NativePlanFileOutcome = z.infer<ReturnType<typeof NativePlanFileOutcomeSchema>>;
