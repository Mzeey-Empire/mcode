import { hasUnseenRestartFailure, isTurnSeen, threadHasRunningDescendants, type ThreadAttention } from "@mcode/contracts/models/thread-attention";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";
import type { ThreadStartupPhase } from "@mcode/contracts/thread-startup";
import type { StartupActivity, ThreadActivity } from "./thread-activity";

/** Third-line label for a thread that is blocked on the user. */
export type NeedsYouLabel =
  | "Approval required"
  | "Answers required"
  | "Plan ready"
  | "Interrupted"
  | "Setup failed"
  | "Fetch failed";

/** The single state a sidebar or palette thread row shows. */
export type ThreadRowState =
  | { kind: "needs-you"; label: NeedsYouLabel }
  | { kind: "setting-up"; phase: ThreadStartupPhase | null }
  | { kind: "running" }
  | { kind: "failed" }
  | { kind: "finished" }
  | { kind: "quiet" };

/** Everything a row needs to pick its state. */
export interface ThreadRowFacts {
  activity: ThreadActivity;
  attention: ThreadAttention | undefined;
  /** The thread is open in a visible, focused window, so its outcome is already in view. */
  onScreen: boolean;
}

const needsYou = (label: NeedsYouLabel): ThreadRowState => ({ kind: "needs-you", label });

/**
 * Picks the row state. A blocking question outranks a running startup or turn because
 * neither can progress without the user; a plan only matters once the turn that wrote it stops.
 * A failed startup shows until a window records that the user saw it. Settled turn outcomes
 * show only until the user sees them. Delegated tasks or background subagents still running
 * after the thread's own turn keep it running, below anything that needs the user and above
 * an unseen settled outcome.
 */
export function deriveThreadRowState(facts: ThreadRowFacts): ThreadRowState {
  const live = liveRowState(facts);
  if (live) return live;
  const settled: ThreadRowState = facts.activity.startup.kind === "failed" ? { kind: "failed" } : settledRowState(facts);
  if (facts.attention && threadHasRunningDescendants(facts.attention) && settled.kind !== "needs-you") return { kind: "running" };
  return settled;
}

function awaitsApproval(waiting: string | undefined, startup: StartupActivity): boolean {
  return waiting === "approval" || (startup.kind === "needs-you" && startup.decision === "setup-approval");
}

function startupNeedsYou(startup: StartupActivity, waiting: string | undefined): ThreadRowState | null {
  if (startup.kind !== "needs-you" || startup.decision === "setup-approval") return null;
  // A plan the agent already wrote outranks a setup it no longer depends on.
  if (waiting === "plan") return null;
  return needsYou(startup.decision === "fetch-failed" ? "Fetch failed" : "Setup failed");
}

function liveRowState({ attention, activity }: ThreadRowFacts): ThreadRowState | null {
  const waiting = attention?.waiting?.kind;
  const { startup } = activity;
  if (awaitsApproval(waiting, startup)) return needsYou("Approval required");
  if (waiting === "questions") return needsYou("Answers required");
  const startupHold = startupNeedsYou(startup, waiting);
  if (startupHold) return startupHold;
  if (startup.kind === "setting-up") return { kind: "setting-up", phase: startup.phase };
  if (activity.turnRunning) return { kind: "running" };
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
  // The server sets a restart failure only when it is newer than the last turn, so it outranks that turn's outcome.
  if (attention && !onScreen && hasUnseenRestartFailure(attention)) return { kind: "failed" };
  const turn = attention?.lastTurn;
  if (!turn || onScreen || isTurnSeen(turn.sequence, attention.seen.sequence)) return { kind: "quiet" };
  return OUTCOME_ROW_STATE[turn.outcome];
}

const ROLLUP_RANK: Record<ThreadRowState["kind"], number> = {
  "needs-you": 5,
  "setting-up": 4,
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
