import { z } from "zod";
import {
  AgentThreadIdSchema,
  type AgentTurnStatus,
} from "../compat/agent-model.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum number of canonical children returned by one roster read. */
export const CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN = 256;

/** Maximum number of ancestor IDs retained for one roster row. */
export const CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH = 64;
/** Maximum persisted length of a delegated task description. */
export const CANONICAL_SUBAGENT_TASK_MAX_LENGTH = 32_768;

/** Request to stop one exact active canonical child turn. */
export const CanonicalSubagentStopRequestSchema = lazySchema(() =>
  z.object({
    owningParentThreadId: AgentThreadIdSchema,
    childThreadId: AgentThreadIdSchema,
  }).strict(),
);

/** Exact terminal state represented in the canonical turn model. */
export const CanonicalSubagentTerminalOutcomeSchema = z.enum([
  "Completed",
  "Cancelled",
  "Interrupted",
  "Errored",
]);

/** Result of one canonical child interruption attempt. */
export const CanonicalSubagentStopResultSchema = lazySchema(() =>
  z.object({
    childThreadId: AgentThreadIdSchema,
    status: z.enum(["interrupted", "already-terminal", "unsupported", "failed"]),
    message: z.string().trim().min(1).max(512).optional(),
  }).strict(),
);

/** Request to stop one exact active canonical child turn. */
export type CanonicalSubagentStopRequest = z.infer<ReturnType<typeof CanonicalSubagentStopRequestSchema>>;

/** Result of one canonical child interruption attempt. */
export type CanonicalSubagentStopResult = z.infer<ReturnType<typeof CanonicalSubagentStopResultSchema>>;

/** Exact terminal outcome for one canonical child turn. */
export type CanonicalSubagentTerminalOutcome = z.infer<typeof CanonicalSubagentTerminalOutcomeSchema>;

/** Convert a canonical turn status to the roster's exact terminal outcome. */
export function canonicalSubagentTerminalOutcome(
  status: AgentTurnStatus | null,
): CanonicalSubagentTerminalOutcome | null {
  switch (status) {
    case "Completed":
      return "Completed";
    case "Interrupted":
      return "Interrupted";
    case "Cancelled":
      return "Cancelled";
    case "Errored":
      return "Errored";
    default:
      return null;
  }
}
