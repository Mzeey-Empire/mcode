import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Why a turn failed, as classified by the adapter that saw the native error. */
export const TurnFailureKindSchema = z.enum(["retryable", "usage_limit", "auth", "fatal"]);

/** Why a turn failed, as classified by the adapter that saw the native error. */
export type TurnFailureKind = z.infer<typeof TurnFailureKindSchema>;

/** Adapter-classified failure carried by every provider Error event. */
export const TurnFailureSchema = lazySchema(() =>
  z.object({
    kind: TurnFailureKindSchema,
    /** HTTP status when the provider exposed one. */
    status: z.number().int().min(100).max(599).optional(),
    /** Provider-native code, e.g. "usageLimitExceeded", "authentication_failed", "-32000". */
    code: z.string().trim().min(1).max(128).optional(),
    /** Relative wait from the moment the adapter emitted the event. The server converts it to resetsAt. */
    retryAfterMs: z.number().int().nonnegative().max(31 * 24 * 3_600_000).optional(),
    /** Provider limit window, e.g. "five_hour", "seven_day". */
    limitType: z.string().trim().min(1).max(64).optional(),
    /** The provider's own retries before giving up. */
    retries: z.object({
      made: z.number().int().nonnegative(),
      max: z.number().int().positive().optional(),
    }).strict().optional(),
  }).strict(),
);

/** Adapter-classified failure carried by every provider Error event. */
export type TurnFailure = z.infer<ReturnType<typeof TurnFailureSchema>>;
