import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { TurnOutcomeSchema } from "./turn-outcome.js";

/** Live reasons a thread needs user input, in precedence order. */
export const ThreadWaitingKindSchema = z.enum(["approval", "questions", "plan"]);
/** A live reason a thread needs user input. */
export type ThreadWaitingKind = z.infer<typeof ThreadWaitingKindSchema>;

/** Highest settled message acknowledged by a client and the server time it advanced. */
export const SeenMarkSchema = lazySchema(() => z.object({
  sequence: z.number().int().nonnegative().nullable(),
  at: z.string().datetime().nullable(),
}).strict());
/** The thread's advance-only acknowledgement marker. */
export type SeenMark = z.infer<ReturnType<typeof SeenMarkSchema>>;

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
  /** True while any task this thread delegated is unfinished, so the thread reads as running after its own turn ends. */
  hasUnfinishedDelegatedTasks: z.boolean(),
}).strict());
/** Durable attention facts plus the current live wait, if any. */
export type ThreadAttention = z.infer<ReturnType<typeof ThreadAttentionSchema>>;

/** True when the user has acknowledged this turn or a later one. */
export function isTurnSeen(turnSequence: number, seenSequence: number | null | undefined): boolean {
  return seenSequence !== null && seenSequence !== undefined && seenSequence >= turnSequence;
}

/** Whether attention prevents a thread from becoming quiet or completing automatically. */
export function threadAttentionNeedsUser(attention: ThreadAttention | null | undefined): boolean {
  if (!attention) return false;
  if (attention.waiting || attention.hasUnfinishedDelegatedTasks) return true;
  const turn = attention.lastTurn;
  return turn !== null && turn.outcome !== "cancelled" && !isTurnSeen(turn.sequence, attention.seen.sequence);
}

/** Atomic old and new markers returned by a seen acknowledgement. */
export const AcknowledgeSeenResultSchema = lazySchema(() => z.object({
  previous: SeenMarkSchema(), current: SeenMarkSchema(),
}).strict());
/** Result of comparing and advancing a thread's seen marker. */
export type AcknowledgeSeenResult = z.infer<ReturnType<typeof AcknowledgeSeenResultSchema>>;
