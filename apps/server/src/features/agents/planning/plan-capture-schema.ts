import { NativePlanFileRefSchema, PLAN_MAX_CONTENT_CHARS, lazySchema } from "@mcode/contracts";
import { z } from "zod";

/** Bounded capture input shared by live acceptance and its durable writer. */
export const PlanPersistenceReadySchema = lazySchema(() => z.object({
  title: z.string().min(1).max(200), contentMd: z.string().min(1).max(PLAN_MAX_CONTENT_CHARS),
  captureSource: z.enum(["native", "fence"]), nativePlanFile: NativePlanFileRefSchema().optional(),
}).strict());
