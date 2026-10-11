import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { AgentTurnIdSchema } from "../compat/agent-model.js";

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

/** Maximum recovery records returned or reconciled in one bounded operation. */
export const MAX_TURN_RECOVERIES = 100;

/** One turn interrupted by a specific backend restart. */
export const RecoveryIncidentEntrySchema = lazySchema(() =>
  z.object({
    workspaceId: z.string().trim().min(1).max(256),
    workspaceName: z.string().trim().min(1).max(256),
    threadId: z.string().trim().min(1).max(256),
    threadTitle: z.string().trim().min(1).max(512),
    executionId: z.string().uuid(),
    startedAt: z.string().datetime({ offset: true }),
    interruptedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().int().nonnegative(),
  }).strict(),
);
/** One turn interrupted by a specific backend restart. */
export type RecoveryIncidentEntry = z.infer<ReturnType<typeof RecoveryIncidentEntrySchema>>;

/** Restart-scoped recovery state that remains stable for the current server run. */
export const RecoveryIncidentSchema = lazySchema(() =>
  z.object({
    id: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    entries: z.array(RecoveryIncidentEntrySchema()).min(1).max(MAX_TURN_RECOVERIES),
  }).strict(),
);
/** Restart-scoped recovery state that remains stable for the current server run. */
export type RecoveryIncident = z.infer<ReturnType<typeof RecoveryIncidentSchema>>;
