import { z } from "zod";
import {
  AgentItemIdSchema,
  AgentThreadIdSchema,
  AgentTurnExecutionIdSchema,
  AgentTurnIdSchema,
  CanonicalTimestampSchema,
  CollaborationActionIdSchema,
  ProviderIdSchema,
  ProviderIdentitySchema,
} from "./identity.js";

const RecordTimestampsSchema = {
  createdAt: CanonicalTimestampSchema,
  updatedAt: CanonicalTimestampSchema,
} as const;
const ProviderIdentitiesSchema = z.array(ProviderIdentitySchema).max(16);

/** Activity state for a canonical agent thread. */
export const AgentThreadActivityStateSchema = z.enum([
  "Starting",
  "Active",
  "Idle",
  "Closed",
  "Unavailable",
]);
/** Activity state for a canonical agent thread. */
export type AgentThreadActivityState = z.infer<typeof AgentThreadActivityStateSchema>;

/** Runtime-neutral canonical thread record. */
export const AgentThreadSchema = z
  .object({
    id: AgentThreadIdSchema,
    workspaceId: z.string().trim().min(1).max(256),
    parentThreadId: AgentThreadIdSchema.optional(),
    rootThreadId: AgentThreadIdSchema,
    owningParentThreadId: AgentThreadIdSchema.optional(),
    providerId: ProviderIdSchema,
    providerIdentities: ProviderIdentitiesSchema,
    activityState: AgentThreadActivityStateSchema,
    conversationRevision: z.number().int().nonnegative(),
    rosterRevision: z.number().int().nonnegative(),
    ...RecordTimestampsSchema,
  })
  .strict();
/** Runtime-neutral canonical thread record. */
export type AgentThread = z.infer<typeof AgentThreadSchema>;

/** Lifecycle state for one canonical execution round. */
export const AgentTurnStatusSchema = z.enum([
  "Pending",
  "Running",
  "Completed",
  "Cancelled",
  "Interrupted",
  "Errored",
]);
/** Lifecycle state for one canonical execution round. */
export type AgentTurnStatus = z.infer<typeof AgentTurnStatusSchema>;

/** Provenance for the action that caused a canonical turn. */
export const AgentTurnTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("provider"),
      providerId: ProviderIdSchema,
      providerIdentities: ProviderIdentitiesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("child"),
      sourceThreadId: AgentThreadIdSchema,
      sourceTurnId: AgentTurnIdSchema,
      sourceItemId: AgentItemIdSchema.optional(),
    })
    .strict(),
]);
/** Provenance for the action that caused a canonical turn. */
export type AgentTurnTrigger = z.infer<typeof AgentTurnTriggerSchema>;

/** Why an interrupted turn stopped. "unknown" covers rows written before causes existed. */
export const InterruptionCauseSchema = z.enum(["app_closed", "provider_exited", "saving_stopped", "unknown"]);
/** Why an interrupted turn stopped. "unknown" covers rows written before causes existed. */
export type InterruptionCause = z.infer<typeof InterruptionCauseSchema>;

/** Provider failure persisted with an errored turn, with any reset time made absolute. */
export const PersistedTurnFailureSchema = z
  .object({
    kind: z.enum(["retryable", "usage_limit", "auth", "fatal"]),
    provider: ProviderIdSchema,
    /** Raw provider text for Details. */
    message: z.string().trim().min(1).max(8_000),
    status: z.number().int().min(100).max(599).optional(),
    code: z.string().trim().min(1).max(128).optional(),
    resetsAt: CanonicalTimestampSchema.optional(),
    limitType: z.string().trim().min(1).max(64).optional(),
    retries: z
      .object({ made: z.number().int().nonnegative(), max: z.number().int().positive().optional() })
      .strict()
      .optional(),
  })
  .strict();
/** Provider failure persisted with an errored turn, with any reset time made absolute. */
export type PersistedTurnFailure = z.infer<typeof PersistedTurnFailureSchema>;

/** Why Mcode itself, not the user, stopped a turn. */
export const SystemStopReasonSchema = z.enum([
  // A Deny could not be delivered upstream, so Mcode stopped the turn fail-closed.
  "approval_unanswerable",
  "thread_control",
  // Teardown of a deleted thread; no notice is ever shown.
  "thread_deleted",
]);
/** Why Mcode itself, not the user, stopped a turn. */
export type SystemStopReason = z.infer<typeof SystemStopReasonSchema>;

/** Who stopped a cancelled turn. Rows written before stop causes existed read as "user". */
export const TurnStopCauseSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("user") }).strict(),
  z.object({ by: z.literal("mcode"), reason: SystemStopReasonSchema }).strict(),
]);
/** Who stopped a cancelled turn. Rows written before stop causes existed read as "user". */
export type TurnStopCause = z.infer<typeof TurnStopCauseSchema>;

/** Cause of a non-completed ending; null for completed and running turns. */
export const AgentTurnEndingSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cancelled"), stop: TurnStopCauseSchema }).strict(),
  z.object({ outcome: z.literal("interrupted"), cause: InterruptionCauseSchema }).strict(),
  z.object({ outcome: z.literal("errored"), failure: PersistedTurnFailureSchema }).strict(),
]);
/** Cause of a non-completed ending; null for completed and running turns. */
export type AgentTurnEnding = z.infer<typeof AgentTurnEndingSchema>;

/** Runtime-neutral canonical turn record. */
export const AgentTurnSchema = z
  .object({
    id: AgentTurnIdSchema,
    threadId: AgentThreadIdSchema,
    status: AgentTurnStatusSchema,
    trigger: AgentTurnTriggerSchema,
    // Stamped by the reducer from routing so clients can correlate the turn to
    // the local runtime without threading the event envelope through state.
    executionId: AgentTurnExecutionIdSchema.optional(),
    attemptOf: AgentTurnIdSchema.nullable().default(null),
    permissionMode: z.enum(["supervised", "full"]),
    approvalReviewMode: z.enum(["manual", "automatic"]),
    approvalReviewReason: z.string().min(1).max(128),
    providerIdentities: ProviderIdentitiesSchema,
    startedAt: CanonicalTimestampSchema.nullable(),
    // When the provider sent its first real frame. Turns persisted before this
    // field existed parse as null rather than failing validation.
    providerStartedAt: CanonicalTimestampSchema.nullable().default(null),
    endedAt: CanonicalTimestampSchema.nullable(),
    // Turns persisted before endings existed parse as null.
    ending: AgentTurnEndingSchema.nullable().default(null),
    ...RecordTimestampsSchema,
  })
  .strict();
/** Runtime-neutral canonical turn record. */
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

/** Semantic item kind stored under one canonical turn. */
export const AgentItemKindSchema = z.enum([
  "message",
  "reasoning",
  "tool-call",
  "tool-result",
  "system",
  "summary",
  "error",
]);
/** Semantic item kind stored under one canonical turn. */
export type AgentItemKind = z.infer<typeof AgentItemKindSchema>;

/** Runtime-neutral canonical semantic item. */
export const AgentItemSchema = z
  .object({
    id: AgentItemIdSchema,
    threadId: AgentThreadIdSchema,
    turnId: AgentTurnIdSchema,
    parentItemId: AgentItemIdSchema.optional(),
    kind: AgentItemKindSchema,
    providerIdentities: ProviderIdentitiesSchema,
    payload: z.record(z.unknown()),
    ...RecordTimestampsSchema,
  })
  .strict();
/** Runtime-neutral canonical semantic item. */
export type AgentItem = z.infer<typeof AgentItemSchema>;

/** Direction of one cross-thread collaboration request or response. */
export const CollaborationActionKindSchema = z.enum([
  "delegate",
  "follow-up",
  "resume",
  "message",
  "return-result",
  "permission",
  "clarification",
]);
/** Direction of one cross-thread collaboration request or response. */
export type CollaborationActionKind = z.infer<typeof CollaborationActionKindSchema>;

/** Delivery state for a collaboration action, separate from turn execution state. */
export const CollaborationActionStatusSchema = z.enum([
  "Pending",
  "Dispatched",
  "Acknowledged",
  "Failed",
]);
/** Delivery state for a collaboration action, separate from turn execution state. */
export type CollaborationActionStatus = z.infer<typeof CollaborationActionStatusSchema>;

/** Maximum retained length of a message sent through one collaboration action. */
export const COLLABORATION_ACTION_MESSAGE_MAX_LENGTH = 32_768;

/** Canonical source reference for a collaboration action. */
export const CollaborationSourceSchema = z
  .object({
    threadId: AgentThreadIdSchema,
    turnId: AgentTurnIdSchema,
    itemId: AgentItemIdSchema,
  })
  .strict();
/** Canonical source reference for a collaboration action. */
export type CollaborationSource = z.infer<typeof CollaborationSourceSchema>;

/** Canonical target reference for a collaboration action. */
export const CollaborationTargetSchema = z
  .object({
    threadId: AgentThreadIdSchema,
    turnId: AgentTurnIdSchema.optional(),
  })
  .strict();
/** Canonical target reference for a collaboration action. */
export type CollaborationTarget = z.infer<typeof CollaborationTargetSchema>;

/** Runtime-neutral record of one directional collaboration delivery. */
export const CollaborationActionSchema = z
  .object({
    id: CollaborationActionIdSchema,
    kind: CollaborationActionKindSchema,
    source: CollaborationSourceSchema,
    target: CollaborationTargetSchema,
    status: CollaborationActionStatusSchema,
    deliveryUnknown: z.boolean(),
    message: z.string().trim().min(1).max(COLLABORATION_ACTION_MESSAGE_MAX_LENGTH).optional(),
    providerIdentities: ProviderIdentitiesSchema,
    ...RecordTimestampsSchema,
  })
  .strict();
/** Runtime-neutral record of one directional collaboration delivery. */
export type CollaborationAction = z.infer<typeof CollaborationActionSchema>;
