import { z } from "zod";
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

/** All canonical progress uses one phase protocol; saved frames carry no live effects. */
export const CanonicalAgentProgressFrameSchema = lazySchema(() => z.discriminatedUnion("phase", [
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

/** One accepted, saved, or recovery frame in the canonical progress channel. */
export type CanonicalAgentProgressFrame = z.infer<ReturnType<typeof CanonicalAgentProgressFrameSchema>>;
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
