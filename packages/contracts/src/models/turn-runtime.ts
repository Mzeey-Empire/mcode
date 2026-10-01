import { z } from "zod";
import { AgentProgressPositionSchema, AgentTurnExecutionIdSchema } from "../compat/agent-model.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Stable identity assigned by Mcode to one logical provider turn. */
export const TurnExecutionIdSchema = AgentTurnExecutionIdSchema;
/** Stable identity assigned by Mcode to one logical provider turn. */
export type TurnExecutionId = z.infer<typeof TurnExecutionIdSchema>;

/** Lifecycle phase projected for one thread's current turn. */
export const TurnRuntimePhaseSchema = z.enum([
  "idle",
  "running",
  "finalizing",
  "completed",
  "interrupted",
  "errored",
  "cancelled",
]);
/** Lifecycle phase projected for one thread's current turn. */
export type TurnRuntimePhase = z.infer<typeof TurnRuntimePhaseSchema>;

/** Saving mode is independent of the current execution's lifecycle phase. */
export const TurnSavingModeSchema = z.enum(["durable", "saving", "save-retrying", "saving-failed", "saving-delayed", "unsaved", "stopping"]);
const savingIdentity = {
  threadId: z.string().min(1).max(256),
  executionId: TurnExecutionIdSchema,
};
const pendingProgress = {
  accepted: AgentProgressPositionSchema,
  saved: AgentProgressPositionSchema,
  pendingEvents: z.number().int().nonnegative().max(8_192),
  pendingBytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
  oldestPendingAt: z.string().datetime({ offset: true }),
};
const savingFailure = z.object({
  kind: z.enum(["transient", "permanent", "capacity"]),
  name: z.string().min(1).max(128),
  message: z.string().min(1).max(2_000),
  code: z.string().min(1).max(128).optional(),
}).strict();

/** Pending and failed saves remain visible after their provider execution completes. */
export const TurnSavingStatusSchema = lazySchema(() => z.discriminatedUnion("mode", [
  z.object({ ...savingIdentity, mode: z.literal("durable") }).strict(),
  z.object({ ...savingIdentity, mode: z.literal("saving-delayed") }).strict(),
  z.object({ ...savingIdentity, mode: z.literal("unsaved") }).strict(),
  z.object({ ...savingIdentity, mode: z.literal("stopping") }).strict(),
  z.object({ ...savingIdentity, mode: z.literal("saving"), ...pendingProgress }).strict(),
  z.object({ ...savingIdentity, mode: z.literal("save-retrying"), ...pendingProgress, failure: savingFailure }).strict(),
  z.object({ ...savingIdentity, mode: z.literal("saving-failed"), ...pendingProgress, failure: savingFailure }).strict(),
]));
/** Server-authoritative saving state correlated with the execution that produced it. */
export type TurnSavingStatus = z.infer<ReturnType<typeof TurnSavingStatusSchema>>;

/** Authoritative reconnect snapshot for one thread. */
export const TurnRuntimeSnapshotSchema = lazySchema(() => z.object({
  threadId: z.string().min(1),
  turnExecutionId: TurnExecutionIdSchema.nullable(),
  phase: TurnRuntimePhaseSchema,
  savingStatus: TurnSavingModeSchema.nullable().optional(),
  /** Completed executions may still have retained saving work. */
  savingStatuses: z.array(TurnSavingStatusSchema()).max(128).optional(),
}));
/** Authoritative reconnect snapshot for one thread. */
export type TurnRuntimeSnapshot = z.infer<ReturnType<typeof TurnRuntimeSnapshotSchema>>;

/** Provider dispatch boundary observed while servicing a user stop. */
export const AgentStopDispatchStateSchema = z.enum([
  "not-dispatched",
  "dispatched",
  "unknown",
]);
/** Provider dispatch boundary observed while servicing a user stop. */
export type AgentStopDispatchState = z.infer<typeof AgentStopDispatchStateSchema>;

/** Authoritative result returned by an agent.stop RPC. */
export const AgentStopResultSchema = lazySchema(() => z.object({
  threadId: z.string().min(1),
  turnExecutionId: TurnExecutionIdSchema.nullable(),
  snapshot: TurnRuntimeSnapshotSchema(),
  status: z.enum(["cancelled", "already-terminal"]),
  dispatchState: AgentStopDispatchStateSchema,
}).strict());
/** Authoritative result returned by an agent.stop RPC. */
export type AgentStopResult = z.infer<ReturnType<typeof AgentStopResultSchema>>;
