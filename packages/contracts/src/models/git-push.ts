import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/**
 * Why git refused a push, read from git's fixed reason for the refused ref. `other` covers every
 * failure git gives no such reason for, such as a sign-in or network error.
 */
export const GitPushFailureKindSchema = lazySchema(() => z.enum([
  "hook-declined",
  "remote-ahead",
  "timed-out",
  "other",
]));
/** Why git refused a push. */
export type GitPushFailureKind = z.infer<ReturnType<typeof GitPushFailureKindSchema>>;

/**
 * Push failure fields carried by the RPC error envelope. The envelope's message is the short
 * reason; `detail` is git's own lines about the refusal, without the command line or local paths.
 */
export const GitPushFailureSchema = lazySchema(() => z.object({
  code: z.literal("GIT_PUSH_FAILED"),
  data: z.object({ kind: GitPushFailureKindSchema(), detail: z.string() }).strict(),
}));
/** Push failure fields carried by the RPC error envelope. */
export type GitPushFailure = z.infer<ReturnType<typeof GitPushFailureSchema>>;
