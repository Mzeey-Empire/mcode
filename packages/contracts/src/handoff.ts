import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** Metadata recorded in the frontmatter of an inline v2 handoff audit. */
export const HandoffAuditMetadataSchema = lazySchema(() => z.object({
  schemaVersion: z.literal(2),
  kind: z.enum(["switch", "fork", "recovery"]),
  fromProvider: z.string().nullable(),
  toProvider: z.string(),
  coveredSequences: z.array(z.number().int().nonnegative()),
  omittedSequences: z.array(z.number().int().nonnegative()),
  budgetBytes: z.number().nonnegative(),
  droppedOptions: z.array(z.object({
    option: z.string(),
    value: z.union([z.string(), z.boolean()]),
    reason: z.string(),
  })),
}));

/** Validated provenance for a stored v2 handoff. */
export type HandoffAuditMetadata = z.infer<ReturnType<typeof HandoffAuditMetadataSchema>>;

/** One user or assistant message as it appears in a stored handoff history. */
export const HandoffTranscriptMessageSchema = lazySchema(() => z.object({
  role: z.enum(["user", "assistant"]),
  /** Provider that wrote the message; null for user messages. */
  provider: z.string().nullable(),
  text: z.string(),
}));

/** A message the target provider received in its handoff history. */
export type HandoffTranscriptMessage = z.infer<ReturnType<typeof HandoffTranscriptMessageSchema>>;
