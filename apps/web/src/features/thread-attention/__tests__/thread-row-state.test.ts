import { describe, expect, it } from "vitest";
import { createMockThreadAttention } from "@mcode/contracts/testing";
import { threadAttentionNeedsUser, type ThreadAttention, type ThreadDescendants, type ThreadWaitingKind } from "@mcode/contracts/models/thread-attention";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";
import {
  deriveThreadRowState,
  rollUpThreadRowStates,
  type ThreadRowFacts,
  type ThreadRowState,
} from "../thread-row-state";
import type { StartupActivity } from "../thread-activity";

const AT = "2026-10-10T10:00:00.000Z";

function attention({
  waiting = null,
  outcome = null,
  turnSequence = 8,
  seen = null,
  descendants = "none",
}: {
  waiting?: ThreadWaitingKind | null;
  outcome?: TurnOutcome | null;
  turnSequence?: number;
  seen?: number | null;
  descendants?: ThreadDescendants;
}): ThreadAttention {
  return createMockThreadAttention({
    threadId: "a",
    waiting: waiting ? { kind: waiting, since: AT } : null,
    lastTurn: outcome ? { outcome, endedAt: AT, sequence: turnSequence, changedFileCount: null } : null,
    seen: { sequence: seen, at: seen === null ? null : AT },
    descendants,
  });
}

interface FactOverrides {
  attention?: ThreadAttention;
  onScreen?: boolean;
  running?: boolean;
  startup?: StartupActivity;
}

function facts({ attention, onScreen = false, running = false, startup = { kind: "none" } }: FactOverrides): ThreadRowFacts {
  return { activity: { startup, turnRunning: running }, attention, onScreen };
}

const SETTING_UP: StartupActivity = { kind: "setting-up", phase: "setup" };
const SETUP_APPROVAL: StartupActivity = { kind: "needs-you", decision: "setup-approval" };
const SETUP_FAILED: StartupActivity = { kind: "needs-you", decision: "setup-failed" };
const FETCH_FAILED: StartupActivity = { kind: "needs-you", decision: "fetch-failed" };
const STARTUP_FAILED: StartupActivity = { kind: "failed" };

const QUIET: ThreadRowState = { kind: "quiet" };
const RUNNING: ThreadRowState = { kind: "running" };
const FAILED: ThreadRowState = { kind: "failed" };
const FINISHED: ThreadRowState = { kind: "finished" };
const approval: ThreadRowState = { kind: "needs-you", label: "Approval required" };
const answers: ThreadRowState = { kind: "needs-you", label: "Answers required" };
const plan: ThreadRowState = { kind: "needs-you", label: "Plan ready" };
const interrupted: ThreadRowState = { kind: "needs-you", label: "Interrupted" };
const setupFailed: ThreadRowState = { kind: "needs-you", label: "Setup failed" };
const fetchFailed: ThreadRowState = { kind: "needs-you", label: "Fetch failed" };
const SETTING_UP_ROW: ThreadRowState = { kind: "setting-up", phase: "setup" };

describe("deriveThreadRowState", () => {
  it.each([
    attention({}),
    attention({ waiting: "approval" }),
    attention({ waiting: "questions" }),
    attention({ waiting: "plan" }),
    attention({ outcome: "completed" }),
    attention({ outcome: "completed", seen: 8 }),
    attention({ outcome: "errored" }),
    attention({ outcome: "errored", seen: 8 }),
    attention({ outcome: "interrupted" }),
    attention({ outcome: "interrupted", seen: 8 }),
    attention({ outcome: "cancelled" }),
    attention({ descendants: "running" }),
    attention({ outcome: "completed", seen: 8, descendants: "needs-you" }),
  ])("agrees with the shared quiet rule for %j", (input) => {
    expect(deriveThreadRowState(facts({ attention: input })).kind === "quiet")
      .toBe(!threadAttentionNeedsUser(input));
  });
  it.each<[string, ThreadRowFacts, ThreadRowState]>([
    ["no facts is quiet", facts({}), QUIET],
    ["running turn", facts({ running: true }), RUNNING],
    ["setup running", facts({ startup: SETTING_UP }), SETTING_UP_ROW],
    ["setting up over a running turn", facts({ running: true, startup: SETTING_UP }), SETTING_UP_ROW],
    ["fetch failed", facts({ startup: FETCH_FAILED }), fetchFailed],
    ["fetch failed over a running turn", facts({ running: true, startup: FETCH_FAILED }), fetchFailed],
    ["plan ready over fetch failed", facts({ startup: FETCH_FAILED, attention: attention({ waiting: "plan" }) }), plan],
    ["unseen startup failure is failed even on screen", facts({ onScreen: true, startup: STARTUP_FAILED }), FAILED],
    ["running turn over a failed startup", facts({ running: true, startup: STARTUP_FAILED }), RUNNING],
    ["plan ready over a failed startup", facts({ startup: STARTUP_FAILED, attention: attention({ waiting: "plan" }) }), plan],
    ["approval while running", facts({ running: true, attention: attention({ waiting: "approval" }) }), approval],
    ["setup approval while running", facts({ running: true, startup: SETUP_APPROVAL }), approval],
    ["questions while running", facts({ running: true, attention: attention({ waiting: "questions" }) }), answers],
    ["approval over questions", facts({ attention: attention({ waiting: "approval" }) }), approval],
    ["running over plan ready", facts({ running: true, attention: attention({ waiting: "plan" }) }), RUNNING],
    ["plan ready over unseen finished", facts({ attention: attention({ waiting: "plan", outcome: "completed" }) }), plan],
    ["plan ready over setup failed", facts({ startup: SETUP_FAILED, attention: attention({ waiting: "plan" }) }), plan],
    ["setup failed over a startup still marked running", facts({ running: true, startup: SETUP_FAILED }), setupFailed],
    ["setup failed over unseen failed", facts({ startup: SETUP_FAILED, attention: attention({ outcome: "errored" }) }), setupFailed],
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
    ["delegating with no last turn is running", facts({ attention: attention({ descendants: "running" }) }), RUNNING],
    ["delegating over unseen finished", facts({ attention: attention({ outcome: "completed", descendants: "running" }) }), RUNNING],
    ["delegating over unseen failed", facts({ attention: attention({ outcome: "errored", descendants: "running" }) }), RUNNING],
    ["unseen interrupted over delegating", facts({ attention: attention({ outcome: "interrupted", descendants: "running" }) }), interrupted],
    ["plan ready over delegating", facts({ attention: attention({ waiting: "plan", outcome: "completed", descendants: "running" }) }), plan],
    ["failed create over an unseen finished turn", facts({ startup: STARTUP_FAILED, attention: attention({ outcome: "completed" }) }), FAILED],
    ["a descendant needing input after a seen completed turn stays running", facts({ attention: attention({ outcome: "completed", seen: 8, descendants: "needs-you" }) }), RUNNING],
    ["a descendant needing input over unseen finished", facts({ attention: attention({ outcome: "completed", descendants: "needs-you" }) }), RUNNING],
    ["approval over a descendant needing input", facts({ attention: attention({ waiting: "approval", outcome: "completed", descendants: "needs-you" }) }), approval],
    ["questions over a descendant needing input", facts({ attention: attention({ waiting: "questions", outcome: "completed", descendants: "needs-you" }) }), answers],
    ["unseen interrupted over a descendant needing input", facts({ attention: attention({ outcome: "interrupted", descendants: "needs-you" }) }), interrupted],
    ["delegating stays running while on screen", facts({ onScreen: true, attention: attention({ outcome: "completed", descendants: "running" }) }), RUNNING],
  ])("%s", (_name, input, expected) => {
    expect(deriveThreadRowState(input)).toEqual(expected);
  });
});

describe("rollUpThreadRowStates", () => {
  it.each<[string, ThreadRowState[], ThreadRowState]>([
    ["empty project is quiet", [], QUIET],
    ["needs you over running", [RUNNING, interrupted, FAILED], interrupted],
    ["needs you over setting up", [SETTING_UP_ROW, fetchFailed], fetchFailed],
    ["setting up over running", [RUNNING, SETTING_UP_ROW, FAILED], SETTING_UP_ROW],
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
      deriveThreadRowState(facts({ attention: attention({ outcome: "completed", descendants: "running" }) })),
      deriveThreadRowState(facts({ attention: attention({ outcome: "errored", seen: 8 }) })),
    ];
    expect(rollUpThreadRowStates(states)).toEqual(RUNNING);
  });
});
