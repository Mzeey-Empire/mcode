import { createAgentModelState, type AgentItem, type AgentModelState, type AgentTurn } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { projectTurnEndings, reuseTurnEndings } from "../turn-endings-projection";

const THREAD_ID = "thread-1";

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

function messageItem(id: string, turnId: string, role: "user" | "assistant", second: number): AgentItem {
  return {
    id: `item-${id}`,
    threadId: THREAD_ID,
    turnId,
    kind: "message",
    providerIdentities: [],
    payload: { projection: "message", message: { id, role } },
    createdAt: at(second),
    updatedAt: at(second),
  };
}

function stateWith(turns: AgentTurn[], items: AgentItem[]): AgentModelState {
  const state = createAgentModelState();
  for (const value of turns) state.turns[value.id] = value;
  for (const value of items) state.items[value.id] = value;
  return state;
}

const FAILED = { outcome: "errored", failure: { kind: "fatal", provider: "codex", message: "boom" } } as const;
const NO_SCHEDULE = { scheduledRetry: null, now: new Date(2026, 9, 11, 9, 0).getTime() };

describe("projectTurnEndings", () => {
  it("shows a retried turn as its first prompt plus the latest attempt's work", () => {
    const state = stateWith(
      [
        turn("t1", 0),
        turn("t2", 10, { status: "Errored", ending: FAILED }),
        turn("t2-retry", 20, { attemptOf: "t2", status: "Errored", ending: FAILED }),
      ],
      [
        messageItem("u1", "t1", "user", 0),
        messageItem("a1", "t1", "assistant", 1),
        messageItem("u2", "t2", "user", 10),
        messageItem("a2", "t2", "assistant", 11),
        messageItem("u2-retry", "t2-retry", "user", 20),
        messageItem("a2-retry", "t2-retry", "assistant", 21),
      ],
    );

    const projection = projectTurnEndings(THREAD_ID, state, NO_SCHEDULE);

    expect([...projection.hiddenMessageIds].sort()).toEqual(["a2", "u2-retry"]);
    expect(Object.keys(projection.endingsByMessageId).sort()).toEqual(["a1", "a2-retry"]);
    expect(projection.endingsByMessageId["a2-retry"]).toEqual({
      turnId: "t2-retry",
      view: {
        foldLabel: "Failed after 5s",
        notice: {
          style: "filled",
          icon: "failed",
          title: "The provider couldn't finish this turn",
          detail: "boom",
          details: "boom",
          primary: { action: "retry", label: "Retry" },
        },
      },
    });
  });

  it("anchors an ending with no reply to the turn's prompt and keeps Retry only on the latest turn", () => {
    const state = stateWith(
      [turn("t1", 0), turn("t2", 10, { status: "Errored", ending: FAILED }), turn("t3", 20)],
      [messageItem("u1", "t1", "user", 0), messageItem("u2", "t2", "user", 10), messageItem("u3", "t3", "user", 20)],
    );

    const ending = projectTurnEndings(THREAD_ID, state, NO_SCHEDULE).endingsByMessageId.u2;

    expect(ending?.turnId).toBe("t2");
    expect(ending?.view.notice).not.toHaveProperty("primary");
  });

  it("shows a failed retry of the first turn even when the provider never started", () => {
    const state = stateWith(
      [
        turn("t1", 0, { status: "Errored", ending: FAILED }),
        turn("t1-retry", 10, { attemptOf: "t1", status: "Errored", ending: FAILED, providerStartedAt: null }),
      ],
      [messageItem("u1", "t1", "user", 0)],
    );

    expect(projectTurnEndings(THREAD_ID, state, NO_SCHEDULE).endingsByMessageId.u1).toEqual({
      turnId: "t1-retry",
      view: {
        foldLabel: null,
        notice: {
          style: "filled",
          icon: "failed",
          title: "The provider couldn't finish this turn",
          detail: "boom",
          details: "boom",
          primary: { action: "retry", label: "Retry" },
        },
      },
    });
  });

  it("ignores running turns and other threads", () => {
    const state = stateWith(
      [turn("t1", 0, { status: "Running", endedAt: null }), turn("other", 5, { threadId: "thread-2", status: "Errored" })],
      [messageItem("u1", "t1", "user", 0)],
    );

    expect(projectTurnEndings(THREAD_ID, state, NO_SCHEDULE)).toEqual({ endingsByMessageId: {}, hiddenMessageIds: new Set() });
  });
});

describe("reuseTurnEndings", () => {
  it("keeps the previous projection when nothing it renders changed", () => {
    const state = stateWith([turn("t1", 0, { status: "Errored", ending: FAILED })], [messageItem("u1", "t1", "user", 0)]);
    const previous = projectTurnEndings(THREAD_ID, state, NO_SCHEDULE);

    expect(reuseTurnEndings(previous, projectTurnEndings(THREAD_ID, state, NO_SCHEDULE))).toBe(previous);

    state.turns.t1 = { ...state.turns.t1!, ending: { ...FAILED, failure: { ...FAILED.failure, message: "other" } } };
    const changed = projectTurnEndings(THREAD_ID, state, NO_SCHEDULE);
    expect(reuseTurnEndings(previous, changed)).toBe(changed);
  });

  it("shows a scheduled retry only on the attempt it names", () => {
    const resetsAt = new Date(2026, 9, 11, 14, 5).toISOString();
    const limited = { outcome: "errored", failure: { kind: "usage_limit", provider: "codex", message: "limit", resetsAt } } as const;
    const state = stateWith([turn("t1", 0, { status: "Errored", ending: limited })], [messageItem("u1", "t1", "user", 0)]);
    const primary = (turnId: string) => {
      const scheduledRetry = { turnId, at: resetsAt };
      const notice = projectTurnEndings(THREAD_ID, state, { ...NO_SCHEDULE, scheduledRetry }).endingsByMessageId.u1?.view.notice;
      return notice?.style === "filled" ? notice.primary : undefined;
    };
    expect(primary("t1")).toEqual({ action: "cancel_retry", label: "Cancel retry" });
    expect(primary("t0")).toEqual({ action: "retry_at", label: "Retry at 14:05", at: resetsAt });
  });
});
