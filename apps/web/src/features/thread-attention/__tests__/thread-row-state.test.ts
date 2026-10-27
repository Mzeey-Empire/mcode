import { describe, expect, it } from "vitest";
import type { ThreadAttention, ThreadWaitingKind } from "@mcode/contracts/models/thread-attention";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";
import {
  deriveThreadRowState,
  rollUpThreadRowStates,
  type ThreadRowFacts,
  type ThreadRowState,
} from "../thread-row-state";

const AT = "2026-10-10T10:00:00.000Z";

function attention({
  waiting = null,
  outcome = null,
  turnSequence = 8,
  seen = null,
  delegating = false,
}: {
  waiting?: ThreadWaitingKind | null;
  outcome?: TurnOutcome | null;
  turnSequence?: number;
  seen?: number | null;
  delegating?: boolean;
}): ThreadAttention {
  return {
    threadId: "a",
    waiting: waiting ? { kind: waiting, since: AT } : null,
    lastTurn: outcome ? { outcome, endedAt: AT, sequence: turnSequence, changedFileCount: null } : null,
    seen: { sequence: seen, at: seen === null ? null : AT },
    hasUnfinishedDelegatedTasks: delegating,
  };
}

function facts(overrides: Partial<ThreadRowFacts>): ThreadRowFacts {
  return { attention: undefined, running: false, setup: null, onScreen: false, ...overrides };
}

const QUIET: ThreadRowState = { kind: "quiet" };
const RUNNING: ThreadRowState = { kind: "running" };
const FAILED: ThreadRowState = { kind: "failed" };
const FINISHED: ThreadRowState = { kind: "finished" };
const approval: ThreadRowState = { kind: "needs-you", label: "Approval required" };
const answers: ThreadRowState = { kind: "needs-you", label: "Answers required" };
const plan: ThreadRowState = { kind: "needs-you", label: "Plan ready" };
const interrupted: ThreadRowState = { kind: "needs-you", label: "Interrupted" };
const setupFailed: ThreadRowState = { kind: "needs-you", label: "Setup failed" };

describe("deriveThreadRowState", () => {
  it.each<[string, ThreadRowFacts, ThreadRowState]>([
    ["no facts is quiet", facts({}), QUIET],
    ["running turn", facts({ running: true }), RUNNING],
    ["setup running", facts({ setup: "running" }), RUNNING],
    ["approval while running", facts({ running: true, attention: attention({ waiting: "approval" }) }), approval],
    ["setup approval while running", facts({ running: true, setup: "awaiting-approval" }), approval],
    ["questions while running", facts({ running: true, attention: attention({ waiting: "questions" }) }), answers],
    ["approval over questions", facts({ attention: attention({ waiting: "approval" }) }), approval],
    ["running over plan ready", facts({ running: true, attention: attention({ waiting: "plan" }) }), RUNNING],
    ["plan ready over unseen finished", facts({ attention: attention({ waiting: "plan", outcome: "completed" }) }), plan],
    ["plan ready over setup failed", facts({ setup: "failed", attention: attention({ waiting: "plan" }) }), plan],
    ["setup failed over a startup still marked running", facts({ running: true, setup: "failed" }), setupFailed],
    ["setup failed over unseen failed", facts({ setup: "failed", attention: attention({ outcome: "errored" }) }), setupFailed],
    ["approval stays while on screen", facts({ onScreen: true, attention: attention({ waiting: "approval" }) }), approval],
    ["running over unseen finished", facts({ running: true, attention: attention({ outcome: "completed" }) }), RUNNING],
    ["unseen completed is finished", facts({ attention: attention({ outcome: "completed" }) }), FINISHED],
    ["unseen errored is failed", facts({ attention: attention({ outcome: "errored" }) }), FAILED],
    ["unseen interrupted needs you", facts({ attention: attention({ outcome: "interrupted" }) }), interrupted],
    ["cancelled is quiet", facts({ attention: attention({ outcome: "cancelled" }) }), QUIET],
    ["on screen finished is quiet", facts({ onScreen: true, attention: attention({ outcome: "completed" }) }), QUIET],
    ["on screen failed is quiet", facts({ onScreen: true, attention: attention({ outcome: "errored" }) }), QUIET],
    ["seen at the turn is quiet", facts({ attention: attention({ outcome: "completed", seen: 8 }) }), QUIET],
    ["seen past the turn is quiet", facts({ attention: attention({ outcome: "errored", seen: 9 }) }), QUIET],
    ["seen before the turn is unseen", facts({ attention: attention({ outcome: "completed", seen: 7 }) }), FINISHED],
    ["seen zero before turn zero is seen", facts({ attention: attention({ outcome: "completed", turnSequence: 0, seen: 0 }) }), QUIET],
    ["never seen turn zero is unseen", facts({ attention: attention({ outcome: "completed", turnSequence: 0 }) }), FINISHED],
    ["delegating with no last turn is running", facts({ attention: attention({ delegating: true }) }), RUNNING],
    ["delegating over unseen finished", facts({ attention: attention({ outcome: "completed", delegating: true }) }), RUNNING],
    ["delegating over unseen failed", facts({ attention: attention({ outcome: "errored", delegating: true }) }), RUNNING],
    ["unseen interrupted over delegating", facts({ attention: attention({ outcome: "interrupted", delegating: true }) }), interrupted],
    ["plan ready over delegating", facts({ attention: attention({ waiting: "plan", outcome: "completed", delegating: true }) }), plan],
    ["delegating stays running while on screen", facts({ onScreen: true, attention: attention({ outcome: "completed", delegating: true }) }), RUNNING],
  ])("%s", (_name, input, expected) => {
    expect(deriveThreadRowState(input)).toEqual(expected);
  });
});

describe("rollUpThreadRowStates", () => {
  it.each<[string, ThreadRowState[], ThreadRowState]>([
    ["empty project is quiet", [], QUIET],
    ["needs you over running", [RUNNING, interrupted, FAILED], interrupted],
    ["running over failed", [FINISHED, FAILED, RUNNING], RUNNING],
    ["failed over finished", [FINISHED, FAILED, QUIET], FAILED],
    ["finished over quiet", [QUIET, FINISHED], FINISHED],
    ["first needs-you wins a tie", [approval, plan], approval],
  ])("%s", (_name, states, expected) => {
    expect(rollUpThreadRowStates(states)).toEqual(expected);
  });

  it("rolls a collapsed project up to running when one thread is delegating", () => {
    const states = [
      deriveThreadRowState(facts({ attention: attention({ outcome: "completed", seen: 8 }) })),
      deriveThreadRowState(facts({ attention: attention({ outcome: "completed", delegating: true }) })),
      deriveThreadRowState(facts({ attention: attention({ outcome: "errored", seen: 8 }) })),
    ];
    expect(rollUpThreadRowStates(states)).toEqual(RUNNING);
  });
});
