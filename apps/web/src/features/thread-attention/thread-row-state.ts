import type { ThreadAttention } from "@mcode/contracts/models/thread-attention";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";

/** Third-line label for a thread that is blocked on the user. */
export type NeedsYouLabel =
  | "Approval required"
  | "Answers required"
  | "Plan ready"
  | "Interrupted"
  | "Setup failed";

/** The single state a sidebar or palette thread row shows. */
export type ThreadRowState =
  | { kind: "needs-you"; label: NeedsYouLabel }
  | { kind: "running" }
  | { kind: "failed" }
  | { kind: "finished" }
  | { kind: "quiet" };

/** Automatic worktree setup as seen by a thread row; null when setup is not gating the thread. */
export type ThreadRowSetup = "running" | "awaiting-approval" | "failed" | null;

/** Everything a row needs to pick its state. */
export interface ThreadRowFacts {
  attention: ThreadAttention | undefined;
  running: boolean;
  setup: ThreadRowSetup;
  /** The thread is open in a visible, focused window, so its outcome is already in view. */
  onScreen: boolean;
}

const needsYou = (label: NeedsYouLabel): ThreadRowState => ({ kind: "needs-you", label });

/** True when the user has acknowledged the turn at `turnSequence` or a later one. */
export function isTurnSeen(turnSequence: number, seenSequence: number | null | undefined): boolean {
  return seenSequence !== null && seenSequence !== undefined && seenSequence >= turnSequence;
}

/**
 * Picks the row state. A blocking question outranks a running turn because
 * the turn cannot progress without the user; a plan only matters once the turn
 * that wrote it stops. Settled outcomes show only until the user sees them.
 * Delegated tasks still running after the thread's own turn keep it running,
 * below anything that needs the user and above an unseen settled outcome.
 */
export function deriveThreadRowState(facts: ThreadRowFacts): ThreadRowState {
  const live = liveRowState(facts);
  if (live) return live;
  const settled = settledRowState(facts);
  if (facts.attention?.hasUnfinishedDelegatedTasks && settled.kind !== "needs-you") return { kind: "running" };
  return settled;
}

/** A pending startup still counts as running, but a failed setup holds it until the user decides. */
function setupFailureHolds(setup: ThreadRowSetup, waiting: string | undefined): boolean {
  return setup === "failed" && waiting !== "plan";
}

function liveRowState({ attention, running, setup }: ThreadRowFacts): ThreadRowState | null {
  const waiting = attention?.waiting?.kind;
  if (waiting === "approval" || setup === "awaiting-approval") return needsYou("Approval required");
  if (waiting === "questions") return needsYou("Answers required");
  if (setupFailureHolds(setup, waiting)) return needsYou("Setup failed");
  if (running || setup === "running") return { kind: "running" };
  if (waiting === "plan") return needsYou("Plan ready");
  return null;
}

const OUTCOME_ROW_STATE: Record<TurnOutcome, ThreadRowState> = {
  interrupted: needsYou("Interrupted"),
  errored: { kind: "failed" },
  completed: { kind: "finished" },
  // The user stopped the turn themselves, so there is nothing to report back.
  cancelled: { kind: "quiet" },
};

function settledRowState({ attention, onScreen }: ThreadRowFacts): ThreadRowState {
  const turn = attention?.lastTurn;
  if (!turn || onScreen || isTurnSeen(turn.sequence, attention.seen.sequence)) return { kind: "quiet" };
  return OUTCOME_ROW_STATE[turn.outcome];
}

const ROLLUP_RANK: Record<ThreadRowState["kind"], number> = {
  "needs-you": 4,
  running: 3,
  failed: 2,
  finished: 1,
  quiet: 0,
};

/** The highest-priority state among a collapsed project's threads. */
export function rollUpThreadRowStates(states: Iterable<ThreadRowState>): ThreadRowState {
  let top: ThreadRowState = { kind: "quiet" };
  for (const state of states) {
    if (ROLLUP_RANK[state.kind] > ROLLUP_RANK[top.kind]) top = state;
  }
  return top;
}
