// @vitest-environment jsdom
import {
  resetThreadStoreForTests,
  getTestThreadAnsweredPlanIds,
  getTestThreadPlanQuestions,
  getTestThreadPlanQuestionsStatus,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach } from "vitest";
import { useThreadStore } from "../stores/threadStore";

/**
 * Tests for the `plan.answered` push-channel handler path. The store action
 * `markPlanAnswered(threadId, assistantMessageId)` is what `ws-events.ts`
 * dispatches into when the server broadcasts a freshly-committed marker.
 */

describe("useThreadStore.markPlanAnswered", () => {
  beforeEach(() => {
    resetThreadStoreForTests();
  });

  it("appends the message id to answeredPlanMessageIdsByThread for the thread", () => {
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    const set = getTestThreadAnsweredPlanIds("t1");
    expect(set).toBeInstanceOf(Set);
    expect(set!.has("a1")).toBe(true);
  });

  it("preserves previously-answered ids on the same thread", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        ["t1", { ...createEmptyThreadRecord(), answeredPlanMessageIds: new Set(["a0"]) }],
      ]),
    });
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    const set = getTestThreadAnsweredPlanIds("t1");
    expect(set!.has("a0")).toBe(true);
    expect(set!.has("a1")).toBe(true);
  });

  it("hides the wizard for the thread when called", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "t1",
          {
            ...createEmptyThreadRecord(),
            planQuestions: [{ id: "q1", category: "TEST", question: "?", options: [] }],
            planQuestionsStatus: "pending",
          },
        ],
      ]),
    });
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    expect(getTestThreadPlanQuestions("t1")).toBeNull();
    expect(getTestThreadPlanQuestionsStatus("t1")).toBe("idle");
  });

  it("only affects the targeted thread (no cross-thread leakage)", () => {
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    expect(
      getTestThreadAnsweredPlanIds("t2"),
    ).toBeUndefined();
  });

  it("adds the id to recentlyAnsweredPlanMessageIds so AnsweredSummary can echo", () => {
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    expect(
      useThreadStore.getState().recentlyAnsweredPlanMessageIds.has("a1"),
    ).toBe(true);
  });
});

describe("useThreadStore.markPlanDismissed", () => {
  beforeEach(() => {
    resetThreadStoreForTests({
      recentlyAnsweredPlanMessageIds: new Set<string>(),
    });
  });

  it("settles the batch the same way markPlanAnswered does", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "t1",
          {
            ...createEmptyThreadRecord(),
            planQuestions: [{ id: "q1", category: "TEST", question: "?", options: [] }],
            planQuestionsStatus: "pending",
          },
        ],
      ]),
    });
    useThreadStore.getState().markPlanDismissed("t1", "a1");

    const set = getTestThreadAnsweredPlanIds("t1");
    expect(set!.has("a1")).toBe(true);
    expect(getTestThreadPlanQuestions("t1")).toBeNull();
    expect(getTestThreadPlanQuestionsStatus("t1")).toBe("idle");
  });

  it("does NOT add the id to recentlyAnsweredPlanMessageIds — dismiss is not submission", () => {
    useThreadStore.getState().markPlanDismissed("t1", "a1");
    expect(
      useThreadStore.getState().recentlyAnsweredPlanMessageIds.has("a1"),
    ).toBe(false);
  });
});

describe("useThreadStore.reconcilePlanQuestions", () => {
  const questions = [{ id: "q1", category: "TEST", question: "?", options: [{ id: "o1", title: "A", description: "" }] }];

  beforeEach(() => {
    resetThreadStoreForTests();
  });

  const revision = (threadId: string) => useThreadStore.getState().records.get(threadId)?.planQuestionsRevision ?? 0;

  it("reopens the stored batch on a thread with no local state", () => {
    useThreadStore.getState().reconcilePlanQuestions("t1", revision("t1"), { assistantMessageId: "a1", questions });
    expect(getTestThreadPlanQuestions("t1")).toEqual(questions);
    expect(getTestThreadPlanQuestionsStatus("t1")).toBe("pending");
  });

  it("keeps a batch closed when it was dismissed while the snapshot was in flight", () => {
    const requestedAt = revision("t1");
    useThreadStore.getState().markPlanDismissed("t1", "a1");
    useThreadStore.getState().reconcilePlanQuestions("t1", requestedAt, { assistantMessageId: "a1", questions });
    expect(getTestThreadPlanQuestions("t1")).toBeNull();
    expect(getTestThreadPlanQuestionsStatus("t1")).toBe("idle");
  });

  it("does not replace a batch the user is already answering", () => {
    useThreadStore.getState().setPlanQuestions("t1", questions);
    useThreadStore.getState().reconcilePlanQuestions("t1", revision("t1"), {
      assistantMessageId: "a2",
      questions: [{ ...questions[0]!, id: "q2" }],
    });
    expect(getTestThreadPlanQuestions("t1")?.[0]?.id).toBe("q1");
  });

  it("drops a snapshot that was requested before a live batch arrived", () => {
    const requestedAt = revision("t1");
    useThreadStore.getState().setPlanQuestions("t1", questions);
    useThreadStore.getState().reconcilePlanQuestions("t1", requestedAt, null);
    expect(getTestThreadPlanQuestionsStatus("t1")).toBe("pending");
  });

  it("closes a dock the server no longer has pending", () => {
    useThreadStore.getState().setPlanQuestions("t1", questions);
    useThreadStore.getState().reconcilePlanQuestions("t1", revision("t1"), null);
    expect(getTestThreadPlanQuestions("t1")).toBeNull();
    expect(getTestThreadPlanQuestionsStatus("t1")).toBe("idle");
  });
});
