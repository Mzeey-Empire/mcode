import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { TurnFileEffectSummarySchema } from "./file-effect.js";

/** Durable file observation for one execution, independent of snapshot retention. */
export const TurnFileEvidenceSchema = lazySchema(() => z.discriminatedUnion("state", [
  z.object({ state: z.literal("tracking") }).strict(),
  z.object({ state: z.literal("recorded"), filesChanged: z.array(z.string()), fileEffects: TurnFileEffectSummarySchema().optional() }).strict(),
  z.object({ state: z.literal("unavailable"), reason: z.enum(["capture-failed", "timed-out", "observation-lost", "restarted"]), knownPaths: z.array(z.string()), fileEffects: TurnFileEffectSummarySchema().optional() }).strict(),
  z.object({ state: z.literal("untracked") }).strict(),
]));

/** The evidence state belongs to an execution even when it produced no assistant message. */
export type TurnFileEvidence = z.infer<ReturnType<typeof TurnFileEvidenceSchema>>;

/** Execution ownership carried on both history pages and late evidence publications. */
export const TurnFileEvidenceEventSchema = lazySchema(() => z.object({
  threadId: z.string(), turnId: z.string(), executionId: z.string(), messageId: z.string().nullable(),
  evidence: TurnFileEvidenceSchema(),
}).strict());

/** One execution's evidence with its display ownership. */
export type TurnFileEvidenceEvent = z.infer<ReturnType<typeof TurnFileEvidenceEventSchema>>;
