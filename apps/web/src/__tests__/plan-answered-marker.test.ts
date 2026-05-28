import {
  resetThreadStoreForTests,
  getTestThreadAnsweredPlanIds,
  getTestThreadPlanQuestions,
  getTestThreadPlanQuestionsStatus,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach } from "vitest";
import {
  useThreadStore,
  extractPendingPlanQuestions,
} from "../stores/threadStore";
import type { Message } from "@mcode/contracts";

/**
 * Tests for the `plan.answered` push-channel handler path. The store action
 * `markPlanAnswered(threadId, assistantMessageId)` is what `ws-events.ts`
 * dispatches into when the server broadcasts a freshly-committed marker.
 */

const PLAN_QUESTIONS = JSON.stringify([
  {
    id: "q1",
    category: "TEST",
    question: "Pick a thing",
    options: [
      { id: "a", title: "A", description: "first" },
      { id: "b", title: "B", description: "second" },
    ],
  },
]);
const FENCE = "```plan-questions\n" + PLAN_QUESTIONS + "\n```";

function msg(role: Message["role"], content: string, id: string): Message {
  return {
    id,
    thread_id: "t1",
    role,
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: new Date().toISOString(),
    sequence: 1,
    attachments: null,
  };
}

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

  it("causes extractPendingPlanQuestions to return null for the marked message", () => {
    const messages = [msg("user", "go", "u1"), msg("assistant", FENCE, "a1")];
    // Before marker: wizard would re-pop.
    expect(extractPendingPlanQuestions(messages, new Set())).not.toBeNull();
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    const set = getTestThreadAnsweredPlanIds("t1");
    expect(extractPendingPlanQuestions(messages, set!)).toBeNull();
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
