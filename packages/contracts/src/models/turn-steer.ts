import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { MessageMentionsSchema } from "./mention.js";

/**
 * Message fields a steer carries. Attachments are not steerable yet: a steered
 * message has no admission step to copy and own attachment files.
 */
const steerMessageFields = () => ({
  content: z.string().min(1),
  mentions: MessageMentionsSchema().optional(),
});

/** Params for `agent.steer`: add a message to the running turn without stopping it. */
export const TurnSteerParamsSchema = lazySchema(() => z.object({
  threadId: z.string().min(1).max(256),
  /** The running turn the user saw. A precondition, never a target to resume. */
  turnExecutionId: z.string().min(1).max(256),
  /** Client id, one per Send now click. It is the operation identity and the transcript message id. */
  messageId: z.string().uuid(),
  ...steerMessageFields(),
}).strict());
/** Validated `agent.steer` params. */
export type TurnSteerParams = z.infer<ReturnType<typeof TurnSteerParamsSchema>>;

/** Answer to `agent.steer`. Every failure instead means the provider never took the message. */
export const TurnSteerResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  /** The provider took the message and the transcript holds it. */
  z.object({ status: z.literal("delivered"), messageId: z.string() }),
  /** The request went out and no answer came back. Mcode never resends it on its own. */
  z.object({ status: z.literal("delivery_unknown"), messageId: z.string() }),
  /** Another window already settled this steer. */
  z.object({ status: z.literal("closed"), messageId: z.string() }),
]));
/** Answer to `agent.steer`. */
export type TurnSteerResult = z.infer<ReturnType<typeof TurnSteerResultSchema>>;

/** RPC failure codes for steering and for admitting a resend of an uncertain steer. */
export const TurnSteerErrorCodeSchema = lazySchema(() => z.enum([
  "turn_not_running",
  "steer_unsupported",
  "steer_rejected",
  "steer_resend_closed",
]));
/** RPC failure code for steering. */
export type TurnSteerErrorCode = z.infer<ReturnType<typeof TurnSteerErrorCodeSchema>>;

/** Structured RPC failure for steering. `steer_rejected` carries the provider's reason. */
export const TurnSteerErrorSchema = lazySchema(() => z.discriminatedUnion("code", [
  z.object({ code: z.literal("turn_not_running"), message: z.string() }),
  z.object({ code: z.literal("steer_unsupported"), message: z.string() }),
  z.object({ code: z.literal("steer_rejected"), message: z.string(), data: z.object({ detail: z.string() }) }),
  z.object({ code: z.literal("steer_resend_closed"), message: z.string() }),
]));
/** Structured RPC failure for steering. */
export type TurnSteerError = z.infer<ReturnType<typeof TurnSteerErrorSchema>>;

/** A steer Mcode holds because the provider may already have it. */
export const HeldSteerSchema = lazySchema(() => {
  const common = { messageId: z.string().uuid(), threadId: z.string().min(1).max(256), ...steerMessageFields() };
  return z.discriminatedUnion("state", [
    z.object({ ...common, state: z.literal("delivery_unknown") }),
    /** Send again stored a resend; the client queues it under `replacementMessageId`. */
    z.object({ ...common, state: z.literal("resend_queued"), replacementMessageId: z.string().uuid() }),
  ]);
});
/** A steer Mcode holds because the provider may already have it. */
export type HeldSteer = z.infer<ReturnType<typeof HeldSteerSchema>>;

/** Upper bound on held steers returned in one `agent.listHeldSteers` answer. */
export const MAX_HELD_STEERS = 500;

/** Answer to `agent.listHeldSteers`, oldest first. */
export const ListHeldSteersResultSchema = lazySchema(() => z.array(HeldSteerSchema()).max(MAX_HELD_STEERS));
/** Answer to `agent.listHeldSteers`. */
export type ListHeldSteersResult = z.infer<ReturnType<typeof ListHeldSteersResultSchema>>;

/** Params for `agent.settleUnknownSteer`. */
export const SettleUnknownSteerParamsSchema = lazySchema(() => z.object({
  messageId: z.string().uuid(),
  action: z.enum(["send-again", "remove"]),
}).strict());
/** Validated `agent.settleUnknownSteer` params. */
export type SettleUnknownSteerParams = z.infer<ReturnType<typeof SettleUnknownSteerParamsSchema>>;

/** Answer to `agent.settleUnknownSteer`. */
export const SettleUnknownSteerResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  /** The resend is stored. Every replay returns the same replacement id. */
  z.object({ status: z.literal("requeued"), replacementMessageId: z.string().uuid() }),
  z.object({ status: z.literal("removed") }),
  /** Nothing is held: already sent or removed, here or in another window. */
  z.object({ status: z.literal("closed") }),
]));
/** Answer to `agent.settleUnknownSteer`. */
export type SettleUnknownSteerResult = z.infer<ReturnType<typeof SettleUnknownSteerResultSchema>>;
