import type { ThreadAttention } from "@mcode/contracts";

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
 */
export function deriveThreadRowState(facts: ThreadRowFacts): ThreadRowState {
  const waiting = facts.attention?.waiting?.kind;
  if (waiting === "approval" || facts.setup === "awaiting-approval") return needsYou("Approval required");
  if (waiting === "questions") return needsYou("Answers required");
  if (facts.running || facts.setup === "running") return { kind: "running" };
  if (waiting === "plan") return needsYou("Plan ready");
  if (facts.setup === "failed") return needsYou("Setup failed");
  const turn = facts.attention?.lastTurn;
  if (!turn || facts.onScreen || isTurnSeen(turn.sequence, facts.attention?.seen.sequence)) {
    return { kind: "quiet" };
  }
  switch (turn.outcome) {
    case "interrupted":
      return needsYou("Interrupted");
    case "errored":
      return { kind: "failed" };
    case "completed":
      return { kind: "finished" };
    case "cancelled":
      return { kind: "quiet" };
  }
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
