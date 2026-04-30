import { describe, it, expect } from "vitest";
import { extractPendingPlanQuestions } from "../stores/threadStore";
import type { Message } from "@mcode/contracts";

/**
 * The plan-questions wizard is suppressed by an authoritative server-side
 * marker. Without a marker, the function falls back to the legacy structural
 * heuristic so threads created before the marker landed still hide the wizard
 * after the user posted answers.
 */
function msg(role: Message["role"], content: string, id = `${role}-${content.slice(0, 8)}`): Message {
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

describe("extractPendingPlanQuestions", () => {
  it("returns parsed questions when no answer marker exists and no answer follows", () => {
    const messages = [msg("user", "go", "u1"), msg("assistant", FENCE, "a1")];
    const out = extractPendingPlanQuestions(messages, new Set());
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(1);
    expect(out![0].id).toBe("q1");
  });

  it("returns null when the assistant message is in the answered marker set", () => {
    const messages = [msg("user", "go", "u1"), msg("assistant", FENCE, "a1")];
    const out = extractPendingPlanQuestions(messages, new Set(["a1"]));
    expect(out).toBeNull();
  });

  it("returns null when a user message follows the fence (legacy fallback for pre-PR threads)", () => {
    const messages = [
      msg("user", "go", "u1"),
      msg("assistant", FENCE, "a1"),
      msg("user", "answers", "u2"),
      msg("assistant", "```plan\n...\n```", "a2"),
    ];
    const out = extractPendingPlanQuestions(messages, new Set());
    expect(out).toBeNull();
  });

  it("ignores trailing assistant messages without a fence and finds the fence above", () => {
    const messages = [
      msg("user", "go", "u1"),
      msg("assistant", FENCE, "a1"),
      msg("assistant", "partial streaming with no fence yet", "a2"),
    ];
    const out = extractPendingPlanQuestions(messages, new Set());
    expect(out).not.toBeNull();
    expect(out![0].id).toBe("q1");
  });
});
