import { z } from "zod";
import { ProviderIdSchema } from "../models/settings.js";
import { lazySchema } from "../utils/lazySchema.js";

/** How the user signs in to a provider. `argv` is a fixed adapter constant, never user input. */
export const ProviderSignInSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("terminal"), argv: z.array(z.string()).min(1).max(8) }),
  ]),
);
/** How the user signs in to a provider. */
export type ProviderSignIn = z.infer<ReturnType<typeof ProviderSignInSchema>>;

/** Sign-in state. `unknown` means Mcode cannot tell, so the bell shows nothing for it. */
export const ProviderAuthSchema = lazySchema(() =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("signed_in") }),
    z.object({ state: z.literal("signed_out"), signIn: ProviderSignInSchema() }),
    z.object({ state: z.literal("unknown") }),
  ]),
);
/** Sign-in state of one provider. */
export type ProviderAuth = z.infer<ReturnType<typeof ProviderAuthSchema>>;

/** The latest active rate limit a provider reported. */
export const ProviderRateLimitSchema = lazySchema(() =>
  z.object({
    /** ISO UTC; null when the provider gave no reset time. */
    resetsAt: z.string().datetime().nullable(),
    /** Provider category such as "five_hour" or "seven_day"; null when not reported. */
    limitType: z.string().max(64).nullable(),
  }),
);
/** The latest active rate limit a provider reported. */
export type ProviderRateLimit = z.infer<ReturnType<typeof ProviderRateLimitSchema>>;

/** What the bell knows about one enabled provider. Carries no usage by design. */
export const ProviderStatusSchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    auth: ProviderAuthSchema(),
    /** Null when the provider is not rate limited. */
    rateLimit: ProviderRateLimitSchema().nullable(),
    checkedAt: z.string(),
  }).strict(),
);
/** What the bell knows about one enabled provider. */
export type ProviderStatus = z.infer<ReturnType<typeof ProviderStatusSchema>>;

/** Raw facts an adapter reports through `describeStatus`; the server adds the rest. */
export interface ProviderStatusFacts {
  auth: ProviderAuth;
}
