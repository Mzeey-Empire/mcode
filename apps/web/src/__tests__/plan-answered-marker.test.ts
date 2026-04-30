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
    useThreadStore.setState({
      answeredPlanMessageIdsByThread: {},
      planQuestionsByThread: {},
      planAnswersByThread: {},
      activeQuestionIndexByThread: {},
      planQuestionsStatusByThread: {},
    });
  });

  it("appends the message id to answeredPlanMessageIdsByThread for the thread", () => {
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    const set = useThreadStore.getState().answeredPlanMessageIdsByThread["t1"];
    expect(set).toBeInstanceOf(Set);
    expect(set!.has("a1")).toBe(true);
  });

  it("preserves previously-answered ids on the same thread", () => {
    useThreadStore.setState({
      answeredPlanMessageIdsByThread: { t1: new Set(["a0"]) },
    });
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    const set = useThreadStore.getState().answeredPlanMessageIdsByThread["t1"];
    expect(set!.has("a0")).toBe(true);
    expect(set!.has("a1")).toBe(true);
  });

  it("hides the wizard for the thread when called", () => {
    useThreadStore.setState({
      planQuestionsByThread: { t1: [{ id: "q1", category: "TEST", question: "?", options: [] }] },
      planQuestionsStatusByThread: { t1: "pending" },
    });
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    expect(useThreadStore.getState().planQuestionsByThread["t1"]).toBeUndefined();
    expect(
      useThreadStore.getState().planQuestionsStatusByThread["t1"],
    ).toBeUndefined();
  });

  it("causes extractPendingPlanQuestions to return null for the marked message", () => {
    const messages = [msg("user", "go", "u1"), msg("assistant", FENCE, "a1")];
    // Before marker: wizard would re-pop.
    expect(extractPendingPlanQuestions(messages, new Set())).not.toBeNull();
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    const set = useThreadStore.getState().answeredPlanMessageIdsByThread["t1"];
    expect(extractPendingPlanQuestions(messages, set!)).toBeNull();
  });

  it("only affects the targeted thread (no cross-thread leakage)", () => {
    useThreadStore.getState().markPlanAnswered("t1", "a1");
    expect(
      useThreadStore.getState().answeredPlanMessageIdsByThread["t2"],
    ).toBeUndefined();
  });
});
