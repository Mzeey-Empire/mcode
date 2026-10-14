import { beforeEach, describe, expect, it } from "vitest";
import type { PlanComment, PlanVersion } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { planCommentThreadFor, readPlanCommentIdsForSend, sendablePlanComments } from "./sendable-plan-comments";

const THREAD_ID = "thread-plan-comments";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";

function version(id: string, number: number, status: PlanVersion["status"]): PlanVersion {
  return { id, version: number, status } as PlanVersion;
}

function comment(id: string, versionId: string, extra: Partial<PlanComment> = {}): PlanComment {
  return { id, versionId, status: "open", sentMessageId: null, carriedFromCommentId: null, ...extra } as PlanComment;
}

const ids = (comments: readonly PlanComment[]) => comments.map((c) => c.id);

describe("sendable plan comments", () => {
  it("offers the open, unsent comments of every version that is not accepted", () => {
    const sendable = sendablePlanComments(
      [version(V1, 1, "superseded"), version(V2, 2, "ready")],
      [
        comment("old", V1),
        comment("open", V2),
        comment("resolved", V2, { status: "resolved" }),
        comment("sent", V2, { sentMessageId: "message-1" }),
      ],
    );

    expect(ids(sendable)).toEqual(["old", "open"]);
  });

  it("leaves out a comment whose carried copy rides instead", () => {
    const sendable = sendablePlanComments(
      [version(V1, 1, "superseded"), version(V2, 2, "ready")],
      [comment("a", V1), comment("b", V1), comment("a2", V2, { carriedFromCommentId: "a" })],
    );

    expect(ids(sendable)).toEqual(["b", "a2"]);
  });

  it("leaves out comments on an accepted version but keeps those on older ones", () => {
    const sendable = sendablePlanComments(
      [version(V1, 1, "superseded"), version(V2, 2, "accepted")],
      [comment("old", V1), comment("accepted", V2)],
    );

    expect(ids(sendable)).toEqual(["old"]);
  });

  it("offers nothing before the thread has a plan", () => {
    expect(sendablePlanComments([], [comment("a", V1)])).toEqual([]);
  });
});

describe("plan comments on a Send", () => {
  beforeEach(() => {
    usePlanStore.setState({ plansByThread: {}, commentsByThread: {}, activeVersionByThread: {} });
  });

  it("reads the comments saved up to the moment of Send", () => {
    usePlanStore.getState().addPlan(THREAD_ID, version(V2, 2, "ready"));
    usePlanStore.getState().setComments(THREAD_ID, [comment("a", V2)]);
    expect(readPlanCommentIdsForSend(THREAD_ID)).toEqual(["a"]);

    usePlanStore.getState().applyCommentsChanged(THREAD_ID, [comment("b", V2)], []);

    expect(readPlanCommentIdsForSend(THREAD_ID)).toEqual(["a", "b"]);
  });

  it("carries plan comments only on a direct send to an existing, idle thread", () => {
    const send = { isNewThread: false, isAgentRunning: false, threadId: THREAD_ID };

    expect(planCommentThreadFor(send)).toBe(THREAD_ID);
    expect(planCommentThreadFor({ ...send, isNewThread: true })).toBeUndefined();
    expect(planCommentThreadFor({ ...send, isAgentRunning: true })).toBeUndefined();
    expect(planCommentThreadFor({ ...send, branchFromMessageId: "m1" })).toBeUndefined();
  });
});
