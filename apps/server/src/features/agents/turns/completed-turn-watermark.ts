import { logger } from "@mcode/shared";
import type { ProviderIdentity, TurnOutcome } from "@mcode/contracts";
import type { ExecutionTerminalPersistenceReceipt } from "../execution/execution-worker-handler.js";
import type { ThreadProviderSessionRepo } from "../../thread-control/persistence/thread-provider-session-repo.js";

/** What a finished turn proves about the provider session that ran it. */
export interface FinishedTurnCoverage {
  threadId: string;
  /** Provider the turn ran on, taken from the turn and never from the thread's current provider. */
  providerId: string;
  /**
   * Session the turn was admitted on. Null for a fresh session, which the provider reports only mid-turn, so
   * the session it holds when the turn is credited stands in.
   */
  sessionId: string | null;
  outcome: TurnOutcome;
  /** The turn's own last persisted message sequence, not the thread's newest. */
  sequence: number | null;
}

/** Describe what a terminal receipt proves about the session that produced it. */
export function coverageOf(threadId: string, persisted: ExecutionTerminalPersistenceReceipt): FinishedTurnCoverage {
  return { threadId, providerId: persisted.providerId, sessionId: persisted.sessionId, outcome: persisted.outcome, sequence: persisted.messageSequence };
}

/** The native session a turn was admitted on, read from the identities recorded at admission. */
export function admittedSessionId(providerId: string, identities: readonly ProviderIdentity[]): string | null {
  const session = identities.find((identity) => identity.providerId === providerId
    && identity.provenance === "native" && (identity.scope === "session" || identity.scope === "thread"));
  return session?.value ?? null;
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
      // Credit the admitted session by id: markSeen ignores a row that has since moved to another session, which
      // resolving here would instead credit with a mark the new session never earned.
      const sessionId = turn.sessionId ?? this.sessions.resolve(turn.threadId, turn.providerId)?.sessionId;
      if (!sessionId) return;
      await this.sessions.markSeen(turn.threadId, turn.providerId, sessionId, turn.sequence);
    } catch (error) {
      logger.warn("Failed to advance provider session watermark", {
        threadId: turn.threadId,
        providerId: turn.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
