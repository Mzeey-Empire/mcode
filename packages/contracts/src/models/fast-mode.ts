import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Provider-reported reasons Fast cannot run. */
export const FastModeUnavailableReasonSchema = lazySchema(() =>
  z.enum(["plan", "extra_usage", "provider_route", "environment", "model", "unreachable", "unknown"]),
);

/** Actual Fast state for the model running in a thread. */
export const FastModeStatusSchema = lazySchema(() => z.discriminatedUnion("state", [
  z.object({ state: z.literal("on"), modelId: z.string() }).strict(),
  z.object({ state: z.literal("cooldown"), modelId: z.string() }).strict(),
  z.object({ state: z.literal("off"), modelId: z.string(), unavailable: FastModeUnavailableReasonSchema().optional() }).strict(),
]));

/** Actual Fast state for the model running in a thread. */
export type FastModeStatus = z.infer<ReturnType<typeof FastModeStatusSchema>>;
