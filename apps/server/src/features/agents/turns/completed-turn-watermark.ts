import { logger } from "@mcode/shared";
import type { TurnOutcome } from "@mcode/contracts";
import type { ExecutionTerminalPersistenceReceipt } from "../execution/execution-worker-handler.js";
import type { ThreadProviderSessionRepo } from "../../thread-control/persistence/thread-provider-session-repo.js";

/** What a finished turn proves about the provider session that ran it. */
export interface FinishedTurnCoverage {
  threadId: string;
  /** Provider the turn ran on, taken from the turn and never from the thread's current provider. */
  providerId: string;
  outcome: TurnOutcome;
  /** The turn's own last persisted message sequence, not the thread's newest. */
  sequence: number | null;
}

/** Describe what a terminal receipt proves about the session that produced it. */
export function coverageOf(threadId: string, persisted: ExecutionTerminalPersistenceReceipt): FinishedTurnCoverage {
  return { threadId, providerId: persisted.providerId, outcome: persisted.outcome, sequence: persisted.messageSequence };
}

/**
 * Advances a provider session's seen-through mark once a turn completes. A completed turn proves the
 * session saw every message up to that turn's own reply, so a later switch back sends only what came
 * after it.
 */
export class CompletedTurnWatermark {
  constructor(private readonly sessions: Pick<ThreadProviderSessionRepo, "resolve" | "markSeen">) {}

  /**
   * Credit the turn to the session it ran on. Never throws: a stale mark costs one resend on the next
   * switch, while failing an already-persisted turn over bookkeeping is worse.
   */
  async record(turn: FinishedTurnCoverage): Promise<void> {
    if (turn.outcome !== "completed" || turn.sequence === null) return;
    try {
      const session = this.sessions.resolve(turn.threadId, turn.providerId);
      if (!session) return;
      await this.sessions.markSeen(turn.threadId, turn.providerId, session.sessionId, turn.sequence);
    } catch (error) {
      logger.warn("Failed to advance provider session watermark", {
        threadId: turn.threadId,
        providerId: turn.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
