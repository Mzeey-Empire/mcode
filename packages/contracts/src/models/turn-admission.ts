import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Why a turn could not be admitted, independent of presentation or retry policy. */
export const TurnAdmissionFailureReasonSchema = lazySchema(() => z.enum([
  "busy",
  "pending_mutation",
  "stopped",
  "unavailable",
]));
/** A classified admission refusal. An unclassified failure has no reason. */
export type TurnAdmissionFailureReason = z.infer<ReturnType<typeof TurnAdmissionFailureReasonSchema>>;

/** Admission fields carried by the RPC error envelope. The envelope owns the message. */
export const TurnAdmissionFailureSchema = lazySchema(() => z.object({
  code: z.literal("TURN_ADMISSION_REJECTED"),
  data: z.object({ reason: TurnAdmissionFailureReasonSchema() }).strict(),
}).strict());
/** Admission fields carried by the RPC error envelope. */
export type TurnAdmissionFailure = z.infer<ReturnType<typeof TurnAdmissionFailureSchema>>;
