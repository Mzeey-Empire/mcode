// @vitest-environment jsdom
import { createMockMessage } from "@mcode/contracts/testing";
import { describe, expect, it } from "vitest";
import type { Message } from "@/transport";
import { latestForkableReply, threadForkPoint } from "../fork-point";
import type { AgentDisplayState, ChatVirtualItem } from "../virtual-items";

const NO_PLANS: ReadonlySet<string> = new Set();

function messageItem(message: Message, agentDisplayState?: AgentDisplayState): ChatVirtualItem {
  return { key: message.id, type: "message", message, ...(agentDisplayState ? { agentDisplayState } : {}) };
}

function reply(id: string, content: string, extra: Partial<Message> = {}): Message {
  return createMockMessage({ id, thread_id: "thread-1", role: "assistant", content, ...extra });
}

describe("latestForkableReply", () => {
  it("skips a goal notice for the reply before it", () => {
    const answer = reply("answer", "Done.");
    const items = [messageItem(answer), messageItem(reply("goal", "Goal achieved in 12s."))];

    expect(latestForkableReply(items, NO_PLANS)?.id).toBe("answer");
  });

  it("skips a reply whose display state is not completed even when its stored outcome is", () => {
    const answer = reply("answer", "Done.");
    const settling = reply("settling", "Almost there", { outcome: "completed" } as Partial<Message>);
    const items = [messageItem(answer, { phase: "completed" }), messageItem(settling, { phase: "finalizing" })];

    expect(latestForkableReply(items, NO_PLANS)?.id).toBe("answer");
  });

  it("returns a completed reply that exists only as a projected item", () => {
    const projected = reply("canonical-only", "From the canonical turn");
    const items = [messageItem(createMockMessage({ id: "ask", thread_id: "thread-1", role: "user", content: "Go" })), messageItem(projected, { phase: "completed" })];

    expect(latestForkableReply(items, NO_PLANS)).toBe(projected);
  });

  it("skips a reply whose body is only a hidden plan-questions fence unless it carries a plan", () => {
    const answer = reply("answer", "Done.");
    const questions = reply("questions", "```plan-questions\n[]\n```");
    const items = [messageItem(answer), messageItem(questions)];

    expect(latestForkableReply(items, NO_PLANS)?.id).toBe("answer");
    expect(latestForkableReply(items, new Set(["questions"]))?.id).toBe("questions");
  });
});

describe("threadForkPoint", () => {
  it("reports newer-not-loaded over a ready reply while newer pages are missing", () => {
    expect(threadForkPoint("thread-1", reply("answer", "Done."), true)).toEqual({ threadId: "thread-1", kind: "newer-not-loaded" });
  });
});
