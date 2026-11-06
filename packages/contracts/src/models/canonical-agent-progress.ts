import { z } from "zod";
import { AgentEventDelivery, agentEventDelivery, AgentEventSchema } from "../events/agent-event.js";
import { AcceptedCanonicalAgentEventEnvelopeSchema, CanonicalAgentEventEnvelopeSchema } from "../compat/agent-model.js";
import { CanonicalAgentReconnectRecoverySchema, CanonicalAgentRevisionSchema } from "./canonical-agent-reconnect.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Upper bound for one immutable progress transport batch. */
export const CANONICAL_AGENT_PROGRESS_BATCH_MAX = 256;
/** Upper bound for a recovery's bounded retained suffix. */
export const CANONICAL_AGENT_PROGRESS_RECOVERY_MAX = 8_192;

const identity = {
  threadId: z.string().min(1).max(256),
  ownerThreadId: z.string().min(1).max(256).optional(),
  epoch: z.string().min(1).max(256),
};
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Live events are bare provider events; a publication id would claim a saved identity they do not have.
 * Only stream fragments may be live: any other event is shown once and never saved, so it would be lost.
 */
const liveEvent = lazySchema(() => z.unknown().superRefine((event, context) => {
  if (typeof event === "object" && event !== null && "publicationId" in event) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Live events cannot have publication ids" });
  }
}).pipe(AgentEventSchema()).refine((event) => agentEventDelivery(event) === AgentEventDelivery.Live,
  { message: "Only text, reasoning and tool-input fragments can be live" }));

const recoveryObject = lazySchema(() => z.object({
  phase: z.literal("recovery"),
  ...identity,
  acceptedThrough: sequence,
  savedThrough: sequence,
  durable: CanonicalAgentReconnectRecoverySchema(),
  retained: z.array(AcceptedCanonicalAgentEventEnvelopeSchema).max(CANONICAL_AGENT_PROGRESS_RECOVERY_MAX),
  loss: z.enum(["none", "runtime-restarted"]),
}).strict());

/** One recovery cut joins actual saved state with the runtime's retained accepted suffix. */
export const CanonicalAgentProgressRecoverySchema = lazySchema(() => recoveryObject().superRefine((frame, context) => {
  validateRecovery(frame, context);
}));

const frameSchema = lazySchema(() => z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("live"),
    ...identity,
    after: sequence,
    liveSequence: sequence,
    events: z.array(liveEvent()).min(1).max(CANONICAL_AGENT_PROGRESS_BATCH_MAX),
  }).strict(),
  z.object({
    phase: z.literal("accepted"),
    ...identity,
    from: sequence,
    through: sequence,
    events: z.array(AcceptedCanonicalAgentEventEnvelopeSchema).min(1).max(CANONICAL_AGENT_PROGRESS_BATCH_MAX),
  }).strict(),
  z.object({
    phase: z.literal("saved"),
    ...identity,
    through: sequence,
    revision: CanonicalAgentRevisionSchema(),
    events: z.array(CanonicalAgentEventEnvelopeSchema).max(CANONICAL_AGENT_PROGRESS_BATCH_MAX),
  }).strict(),
  recoveryObject(),
]).superRefine((frame, context) => {
  if (frame.phase === "recovery") { validateRecovery(frame, context); return; }
  if (frame.phase === "live") return;
  if (frame.events.some((event) => event.routing.threadId !== (frame.ownerThreadId ?? frame.threadId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Progress event belongs to another thread" });
  }
  if (frame.phase !== "accepted") return;
  if (frame.from + frame.events.length !== frame.through
    || frame.events.some((event, index) => event.progressPosition.epoch !== frame.epoch
      || event.progressPosition.sequence !== frame.from + index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Accepted progress must be contiguous in its epoch" });
  }
}));

/** One live, accepted, saved, or recovery frame in the canonical progress channel. */
export type CanonicalAgentProgressFrame = z.infer<ReturnType<typeof frameSchema>>;

/**
 * All canonical progress uses one phase protocol; live frames carry no position and saved frames no live effects.
 * The named type keeps the WS channel map's inferred type small enough for declaration emit.
 */
export const CanonicalAgentProgressFrameSchema = lazySchema<z.ZodType<CanonicalAgentProgressFrame, z.ZodTypeDef, unknown>>(
  () => frameSchema());
/** Owner-consistent saved prefix plus retained suffix for reconnect. */
export type CanonicalAgentProgressRecovery = z.infer<ReturnType<typeof CanonicalAgentProgressRecoverySchema>>;

function validateRecovery(frame: z.infer<ReturnType<typeof recoveryObject>>, context: z.RefinementCtx): void {
  const ownerThreadId = frame.ownerThreadId ?? frame.threadId;
  if (frame.durable.threadId !== ownerThreadId || frame.savedThrough > frame.acceptedThrough
    || frame.acceptedThrough - frame.savedThrough !== frame.retained.length
    || frame.retained.some((event, index) => event.routing.threadId !== ownerThreadId
      || event.progressPosition.epoch !== frame.epoch
      || event.progressPosition.sequence !== frame.savedThrough + index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Recovery must join one saved prefix and contiguous retained suffix" });
  }
}
