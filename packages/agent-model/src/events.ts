import { z } from "zod";
import { CollaborationObservationChangeSchema } from "./collaboration-observation.js";
import {
  AgentEventIdSchema,
  AgentEventRoutingSchema,
  AgentItemIdSchema,
  CanonicalTimestampSchema,
  ProviderIdSchema,
  ProviderIdentitySchema,
} from "./identity.js";
import {
  AgentItemSchema,
  AgentThreadSchema,
  AgentTurnSchema,
  CollaborationActionSchema,
} from "./records.js";

const PendingAgentTurnSchema = AgentTurnSchema.refine(
  (turn) => turn.status === "Pending",
  "A created turn must be pending",
);

/** Semantic event payload that records one canonical model entity. */
export const CanonicalAgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("collaboration.observed"), changes: z.array(CollaborationObservationChangeSchema).min(1).max(256) }).strict(),
  z.object({ type: z.literal("execution.checkpoint"), operationKind: z.enum([
    "begin", "append-events", "narrative-delta", "live-event", "checkpoint",
    "stop-requested", "effect-result", "provider-outcome", "worker-lost",
    "finish-live-event", "post-terminal-event", "plan-answer",
  ]) }).strict(),
  z.object({ type: z.literal("turn.response-bound"), messageId: AgentItemIdSchema,
    outcome: z.enum(["completed", "cancelled", "interrupted", "errored"]), endedAt: CanonicalTimestampSchema }).strict(),
  z.object({ type: z.literal("thread.recorded"), thread: AgentThreadSchema }).strict(),
  z
    .object({
      type: z.literal("child-thread.recorded"),
      parentThreadId: AgentThreadSchema.shape.id,
      childThread: AgentThreadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("child-thread.bound"),
      parentThreadId: AgentThreadSchema.shape.id,
      childThreadId: AgentThreadSchema.shape.id,
      providerIdentity: ProviderIdentitySchema,
    })
    .strict(),
  z.object({ type: z.literal("turn.created"), turn: PendingAgentTurnSchema }).strict(),
  z.object({ type: z.literal("turn.started"), startedAt: CanonicalTimestampSchema }).strict(),
  z.object({ type: z.literal("turn.completed"), endedAt: CanonicalTimestampSchema }).strict(),
  z
    .object({
      type: z.literal("turn.cancelled"),
      endedAt: CanonicalTimestampSchema,
      reason: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn.interrupted"),
      endedAt: CanonicalTimestampSchema,
      reason: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn.errored"),
      endedAt: CanonicalTimestampSchema,
      error: z.string().trim().min(1).max(8_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("ingest.overflow"),
      endedAt: CanonicalTimestampSchema,
      acceptedStoppingSequence: z.number().int().nonnegative(),
      durableStoppingSequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ingest.volatile-truncated"),
      droppedEventCount: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("item.recorded"), item: AgentItemSchema }).strict(),
  z
    .object({
      type: z.literal("publication.recorded"),
      publicationId: z.string().regex(/^[1-9]\d*$/).max(16),
      /** Renderer-facing agent event; opaque here because the canonical layer is provider-agnostic. */
      event: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal("collaboration-action.recorded"),
      collaborationAction: CollaborationActionSchema,
    })
    .strict(),
]);
/** Semantic event payload that records one canonical model entity. */
export type CanonicalAgentEvent = z.infer<typeof CanonicalAgentEventSchema>;

/** Volatile stream epochs distinguish retained progress from saved history after restart. */
export const AgentProgressPositionSchema = z.object({
  epoch: z.string().min(1).max(256),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
/** Volatile stream position with no durability claim. */
export type AgentProgressPosition = z.infer<typeof AgentProgressPositionSchema>;

const SemanticAgentEventEnvelopeBaseSchema = z
  .object({
    eventId: AgentEventIdSchema,
    routing: AgentEventRoutingSchema,
    sourceProviderId: ProviderIdSchema,
    sourceIdentities: z.array(ProviderIdentitySchema).max(16),
    sourceSequence: z.number().int().nonnegative().optional(),
    acceptedSequence: z.number().int().positive(),
    providerTimestamp: CanonicalTimestampSchema.optional(),
    serverTimestamps: z
      .object({
        acceptedAt: CanonicalTimestampSchema,
        persistedAt: CanonicalTimestampSchema.optional(),
      })
      .strict(),
  })
  .strict();

/** Validated canonical envelope for one semantic event payload schema. */
export function AgentEventEnvelopeSchema<TSchema extends z.ZodTypeAny>(payloadSchema: TSchema) {
  return SemanticAgentEventEnvelopeBaseSchema.extend({
    durableRevision: z.number().int().nonnegative(),
    rosterRevision: z.number().int().nonnegative().optional(),
    progressPosition: AgentProgressPositionSchema.optional(),
    payload: payloadSchema,
  });
}

/** Pure semantic reduction does not require a durable revision. */
export const CanonicalAgentSemanticEnvelopeSchema = SemanticAgentEventEnvelopeBaseSchema.extend({ payload: CanonicalAgentEventSchema });
/** One accepted event may be displayed before its immutable write is saved. */
export const AcceptedCanonicalAgentEventEnvelopeSchema = CanonicalAgentSemanticEnvelopeSchema.extend({
  progressPosition: AgentProgressPositionSchema,
});
/** One accepted event with stable identities and an independent progress position. */
export type AcceptedCanonicalAgentEventEnvelope = z.infer<typeof AcceptedCanonicalAgentEventEnvelopeSchema>;

/** Canonical event envelope with independent source, accepted, and durable ordering. */
export type AgentEventEnvelope<TPayload = CanonicalAgentEvent> = {
  eventId: string;
  routing: z.infer<typeof AgentEventRoutingSchema>;
  sourceProviderId: string;
  sourceIdentities: readonly z.infer<typeof ProviderIdentitySchema>[];
  sourceSequence?: number;
  acceptedSequence: number;
  durableRevision: number;
  rosterRevision?: number;
  progressPosition?: AgentProgressPosition;
  providerTimestamp?: string;
  serverTimestamps: {
    acceptedAt: string;
    persistedAt?: string;
  };
  payload: TPayload;
};

/** Schema for a canonical semantic event envelope. */
export const CanonicalAgentEventEnvelopeSchema = AgentEventEnvelopeSchema(CanonicalAgentEventSchema);
/** Canonical semantic event envelope. */
export type CanonicalAgentEventEnvelope = z.infer<typeof CanonicalAgentEventEnvelopeSchema>;
