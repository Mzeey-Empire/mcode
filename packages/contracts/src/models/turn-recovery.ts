import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { AgentTurnIdSchema } from "../compat/agent-model.js";

/** One explicitly scheduled retry of an errored attempt. */
export const ScheduledTurnRetrySchema = lazySchema(() => z.object({
  turnId: AgentTurnIdSchema,
  at: z.string().datetime({ offset: true }),
}).strict());
/** Persisted retry notice restored when a thread is loaded. */
export type ScheduledTurnRetry = z.infer<ReturnType<typeof ScheduledTurnRetrySchema>>;

/** Schedule the latest errored attempt on a thread. */
export const TurnRetryScheduleParamsSchema = lazySchema(() => ScheduledTurnRetrySchema().extend({
  threadId: z.string().min(1).max(256),
}).strict());
/** Input to the scheduled retry command. */
export type TurnRetryScheduleParams = z.infer<ReturnType<typeof TurnRetryScheduleParamsSchema>>;

/** Cancel a thread's pending retry. */
export const TurnRetryUnscheduleParamsSchema = lazySchema(() => z.object({
  threadId: z.string().min(1).max(256),
}).strict());

/** A committed change to a thread's scheduled retry. */
export const ThreadRetryScheduledSchema = lazySchema(() => z.object({
  threadId: z.string(),
  retry: ScheduledTurnRetrySchema().nullable(),
}).strict());

/** Retry the latest errored attempt, optionally switching its model. */
export const TurnRetryParamsSchema = lazySchema(() => z.object({
  threadId: z.string().min(1).max(256),
  turnId: AgentTurnIdSchema,
  model: z.string().trim().min(1).max(256).optional(),
}).strict());
/** Input for an explicit retry of an errored attempt. */
export type TurnRetryParams = z.infer<ReturnType<typeof TurnRetryParamsSchema>>;

/** Identity of the newly admitted attempt. */
export const TurnRetryResultSchema = lazySchema(() => z.object({
  turnId: AgentTurnIdSchema,
}).strict());
/** Identity returned after retry admission succeeds. */
export type TurnRetryResult = z.infer<ReturnType<typeof TurnRetryResultSchema>>;

/** Resume the latest interrupted attempt as a new attempt of the same turn. */
export const TurnResumeParamsSchema = lazySchema(() => z.object({
  threadId: z.string().min(1).max(256),
  turnId: AgentTurnIdSchema,
}).strict());
/** Input for resuming an interrupted attempt. */
export type TurnResumeParams = z.infer<ReturnType<typeof TurnResumeParamsSchema>>;

/**
 * How a resumed attempt continues. `native-session` continues the provider's
 * saved session; `seeded-session` starts a fresh session seeded with the
 * thread's visible conversation because the saved session was unavailable.
 */
export const TurnResumeModeSchema = lazySchema(() => z.enum(["native-session", "seeded-session"]));
/** How a resumed attempt continues. */
export type TurnResumeMode = z.infer<ReturnType<typeof TurnResumeModeSchema>>;

/** Identity and continuation mode of the attempt that carries the resume. */
export const TurnResumeResultSchema = lazySchema(() => z.object({
  turnId: AgentTurnIdSchema,
  mode: TurnResumeModeSchema(),
}).strict());
/** Identity and continuation mode returned after resume admission succeeds. */
export type TurnResumeResult = z.infer<ReturnType<typeof TurnResumeResultSchema>>;

/** Maximum recovery records returned or reconciled in one bounded operation. */
export const MAX_TURN_RECOVERIES = 100;
