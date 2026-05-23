import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** A single section within a structured plan (full content, used in plan-output blocks). */
export const PlanSectionSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    level: z.number().min(1).max(3),
    content: z.string(),
  }),
);

export type PlanSection = z.infer<ReturnType<typeof PlanSectionSchema>>;

/** Lightweight section metadata for TOC navigation (no content body). */
export const PlanSectionNavSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    level: z.number().min(1).max(3),
  }),
);

export type PlanSectionNav = z.infer<ReturnType<typeof PlanSectionNavSchema>>;

/** Structured plan output emitted by the agent inside a ```plan-output fence. */
export const PlanOutputSchema = lazySchema(() =>
  z.object({
    title: z.string(),
    changeSummary: z.string().optional(),
    sections: z.array(PlanSectionSchema()).min(1),
  }),
);

export type PlanOutput = z.infer<ReturnType<typeof PlanOutputSchema>>;

/** Plan status lifecycle. */
export const PlanStatusSchema = lazySchema(() =>
  z.enum(["draft", "accepted", "superseded"]),
);

export type PlanStatus = z.infer<ReturnType<typeof PlanStatusSchema>>;

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
