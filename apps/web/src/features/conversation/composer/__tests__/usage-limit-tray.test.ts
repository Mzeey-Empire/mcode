import { createAgentModelState, type AgentModelState, type AgentTurn } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { timeUntil } from "../../turn-ending/usage-limit";
import { latestUsageLimitStop, usageLimitTrayState, type UsageLimitStop } from "../usage-limit-tray";

const THREAD_ID = "thread-1";
const RESETS_AT = "2026-10-11T14:05:00.000Z";

const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 12, 0, second)).toISOString();

function turn(id: string, second: number, overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id,
    threadId: THREAD_ID,
    status: "Completed",
    trigger: { kind: "user" },
    permissionMode: "full",
    approvalReviewMode: "manual",
    approvalReviewReason: "manual-requested",
    attemptOf: null,
    providerIdentities: [],
    startedAt: at(second),
    providerStartedAt: at(second),
    endedAt: at(second + 5),
    ending: null,
    createdAt: at(second),
    updatedAt: at(second + 5),
    ...overrides,
  };
}

function limited(id: string, second: number, usageLimit: { resetsAt?: string; limitType?: string } = { resetsAt: RESETS_AT, limitType: "five_hour" }): AgentTurn {
  return turn(id, second, { status: "Interrupted", ending: { outcome: "interrupted", cause: "usage_limit", usageLimit } });
}

function stateWith(...turns: AgentTurn[]): AgentModelState {
  const state = createAgentModelState();
  state.threads[THREAD_ID] = {
    id: THREAD_ID, workspaceId: "workspace-1", rootThreadId: THREAD_ID, providerId: "codex", providerIdentities: [],
    activityState: "Idle", conversationRevision: 1, rosterRevision: 0, createdAt: at(0), updatedAt: at(0),
  };
  for (const value of turns) state.turns[value.id] = value;
  return state;
}

const STOP: UsageLimitStop = { turnId: "t2", provider: "Codex", limitLabel: "5-hour limit", resetsAt: RESETS_AT };

describe("latestUsageLimitStop", () => {
  it("reads the latest turn's usage-limit stop with its provider, window, and reset time", () => {
    expect(latestUsageLimitStop(THREAD_ID, stateWith(turn("t1", 0), limited("t2", 10)))).toEqual(STOP);
  });

  it("omits a window and reset time the provider did not report", () => {
    expect(latestUsageLimitStop(THREAD_ID, stateWith(limited("t1", 0, {})))).toEqual({
      turnId: "t1", provider: "Codex", limitLabel: undefined, resetsAt: undefined,
    });
  });

  it("finds the stop on a resumed attempt that hit the limit again", () => {
    const state = stateWith(limited("t1", 0), limited("t1-resume", 10, { resetsAt: RESETS_AT, limitType: "seven_day" }));
    state.turns["t1-resume"] = { ...state.turns["t1-resume"]!, attemptOf: "t1" };
    expect(latestUsageLimitStop(THREAD_ID, state)).toMatchObject({ turnId: "t1-resume", limitLabel: "Weekly limit" });
  });

  it.each([
    ["a newer turn started", stateWith(limited("t1", 0), turn("t2", 10, { status: "Running", endedAt: null, ending: null }))],
    ["a resume attempt is running", stateWith(limited("t1", 0), turn("t1-resume", 10, { attemptOf: "t1", status: "Running", endedAt: null }))],
    ["another cause interrupted the turn", stateWith(turn("t1", 0, { status: "Interrupted", ending: { outcome: "interrupted", cause: "app_closed" } }))],
    ["a legacy usage-limit failure errored the turn", stateWith(turn("t1", 0, { status: "Errored",
      ending: { outcome: "errored", failure: { kind: "usage_limit", provider: "codex", message: "limit" } } }))],
    ["the thread has no turns", stateWith()],
  ])("is null when %s", (_case, state) => {
    expect(latestUsageLimitStop(THREAD_ID, state)).toBeNull();
  });

  it("ignores another thread's usage-limit stop", () => {
    const state = stateWith(turn("t1", 0));
    state.turns["other"] = { ...limited("other", 10), threadId: "thread-2" };
    expect(latestUsageLimitStop(THREAD_ID, state)).toBeNull();
  });
});

describe("usageLimitTrayState", () => {
  it("offers the limit's actions when nothing is scheduled", () => {
    expect(usageLimitTrayState(STOP, null, false)).toEqual({ kind: "limit", ...STOP });
  });

  it("shows the scheduled resume of this stop", () => {
    expect(usageLimitTrayState(STOP, { turnId: "t2", at: RESETS_AT }, false)).toEqual({ kind: "scheduled", turnId: "t2", at: RESETS_AT });
  });

  it("ignores a schedule left from an earlier stop", () => {
    expect(usageLimitTrayState(STOP, { turnId: "t1", at: RESETS_AT }, false)).toEqual({ kind: "limit", ...STOP });
  });

  it.each([
    ["no stop", null, false],
    ["a running thread", STOP, true],
  ] as const)("is hidden for %s", (_case, stop, running) => {
    expect(usageLimitTrayState(stop, { turnId: "t2", at: RESETS_AT }, running)).toBeNull();
  });
});

describe("timeUntil", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  it.each([
    ["2026-10-11T14:13:00.000Z", "in 2h 13m"],
    ["2026-10-11T12:12:30.000Z", "in 13m"],
    ["2026-10-11T12:00:01.000Z", "in 1m"],
    ["2026-10-11T11:59:00.000Z", "in 1m"],
    ["2026-10-13T15:00:00.000Z", "in 2d 3h"],
  ])("reads %s as %s", (target, label) => {
    expect(timeUntil(target, now)).toBe(label);
  });
});
