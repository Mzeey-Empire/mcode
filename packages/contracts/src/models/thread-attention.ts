import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { TurnOutcomeSchema } from "./turn-outcome.js";
import { isLiveSubagentStatus, type SubagentStatus } from "./subagent-roster.js";

/** Live reasons a thread needs user input, in precedence order. */
export const ThreadWaitingKindSchema = z.enum(["approval", "questions", "plan"]);
/** A live reason a thread needs user input. */
export type ThreadWaitingKind = z.infer<typeof ThreadWaitingKindSchema>;

/** Subagents and delegated tasks that outlive this thread's own turn. `needs-you` means one is blocked on the user. */
export const ThreadDescendantsSchema = z.enum(["none", "running", "needs-you"]);
/** Work that outlives this thread's turn. `needs-you` means one descendant is blocked on the user. */
export type ThreadDescendants = z.infer<typeof ThreadDescendantsSchema>;

/** Highest settled message acknowledged by a client and the server time it advanced. */
export const SeenMarkSchema = lazySchema(() => z.object({
  sequence: z.number().int().nonnegative().nullable(),
  at: z.string().datetime().nullable(),
}).strict());
/** The thread's advance-only acknowledgement marker. */
export type SeenMark = z.infer<ReturnType<typeof SeenMarkSchema>>;

/** Where a planned-restart failure notice sits in the transcript and when it was written. */
export const RestartFailureSchema = lazySchema(() => z.object({
  sequence: z.number().int().nonnegative(),
  at: z.string(),
}).strict());

/** Provider-neutral facts for thread attention and review. */
export const ThreadAttentionSchema = lazySchema(() => z.object({
  threadId: z.string().min(1).max(256),
  waiting: z.object({ kind: ThreadWaitingKindSchema, since: z.string() }).nullable(),
  lastTurn: z.object({
    outcome: TurnOutcomeSchema,
    endedAt: z.string(),
    sequence: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative().nullable(),
  }).nullable(),
  seen: SeenMarkSchema(),
  descendants: ThreadDescendantsSchema,
  /**
   * The thread's newest planned-restart failure notice, when it is newer than the last settled turn and that turn
   * did not error. Derived on each read and never stored, so a failure that left no turn still alerts.
   */
  restartFailure: RestartFailureSchema().nullable(),
}).strict());
/** Durable attention facts plus the current live wait, if any. */
export type ThreadAttention = z.infer<ReturnType<typeof ThreadAttentionSchema>>;

/** True when the user has acknowledged this turn or a later one. */
export function isTurnSeen(turnSequence: number, seenSequence: number | null | undefined): boolean {
  return seenSequence !== null && seenSequence !== undefined && seenSequence >= turnSequence;
}

/** Fold live roster statuses into the attention state of the owning thread. */
export function foldDescendants(statuses: Iterable<SubagentStatus>): ThreadDescendants {
  let descendants: ThreadDescendants = "none";
  for (const status of statuses) {
    if (status === "needs-you") return "needs-you";
    if (isLiveSubagentStatus(status)) descendants = "running";
  }
  return descendants;
}

/** Whether a planned-restart failure is newer than what the user has seen. */
export function hasUnseenRestartFailure(attention: ThreadAttention): boolean {
  return attention.restartFailure !== null && !isTurnSeen(attention.restartFailure.sequence, attention.seen.sequence);
}

/** Whether attention prevents a thread from becoming quiet or completing automatically. */
export function threadAttentionNeedsUser(attention: ThreadAttention | null | undefined): boolean {
  if (!attention) return false;
  if (attention.waiting || attention.descendants !== "none") return true;
  if (hasUnseenRestartFailure(attention)) return true;
  const turn = attention.lastTurn;
  return turn !== null && turn.outcome !== "cancelled" && !isTurnSeen(turn.sequence, attention.seen.sequence);
}

/** Atomic old and new markers returned by a seen acknowledgement. */
export const AcknowledgeSeenResultSchema = lazySchema(() => z.object({
  previous: SeenMarkSchema(), current: SeenMarkSchema(),
}).strict());
/** Result of comparing and advancing a thread's seen marker. */
export type AcknowledgeSeenResult = z.infer<ReturnType<typeof AcknowledgeSeenResultSchema>>;
