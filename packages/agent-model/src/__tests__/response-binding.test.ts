import { describe, expect, it } from "vitest";
import type { AgentItem } from "../records.js";
import { bindResponseItems } from "../response-binding.js";

const NOW = "2026-09-30T12:00:00.000Z";
const END = "2026-09-30T12:00:03.000Z";
function item(id: string, kind: string, record: Record<string, unknown>, threadId = "thread", turnId = "turn"): AgentItem {
  return { id, threadId, turnId, kind: "system", providerIdentities: [],
    payload: { projection: "narrativeRecovery", narrative: { kind, record }, identity: "native-child" }, createdAt: NOW, updatedAt: NOW };
}
const input = { threadId: "thread", turnId: "turn", messageId: "message", endedAt: END, outcome: "interrupted" } as const;

describe("response narrative binding", () => {
  it("preserves owned commentary and explicit final flags even when their text matches the answer", () => {
    const exactId = `assistant-text:${"a".repeat(64)}`;
    const suffixId = `assistant-text:${"b".repeat(64)}`;
    const finalId = `assistant-text:${"c".repeat(64)}`;
    const exact = item("exact", "narrationSegment", { id: exactId, text: "Answer", sort_order: 1, is_final_response: 0 });
    const suffix = item("suffix", "narrationSegment", { id: suffixId, text: "swer", sort_order: 3, is_final_response: 0 });
    const final = item("final", "narrationSegment", { id: finalId, text: "Answer", sort_order: 2, is_final_response: 1 });
    const response: AgentItem = { ...exact, id: "message:message", kind: "message",
      payload: { projection: "message", message: { content: "Answer" } } };
    const values = [exact, suffix, final, response];
    const bound = bindResponseItems(Object.fromEntries(values.map((value) => [value.id, value])), input);
    expect(bound.exact?.payload.record).toMatchObject({ text: "Answer", is_final_response: 0 });
    expect(bound.suffix?.payload.record).toMatchObject({ text: "swer", is_final_response: 0 });
    expect(bound.final?.payload.record).toMatchObject({ text: "Answer", is_final_response: 1 });
  });

  it("binds5000 accepted records in one immutable pass and preserves other turns", () => {
    const tools = Array.from({ length: 5_000 }, (_, i) => item(`toolCall:${i}`, "toolCall", {
      id: String(i), message_id: "", status: "completed", completed_at: NOW }));
    const foreign = item("foreign", "toolCall", { message_id: "", status: "running" }, "other", "turn");
    const items = Object.fromEntries([...tools, foreign].map((value) => [value.id, value]));
    const bound = bindResponseItems(items, input);
    expect(Object.values(bound).filter((value) => value.payload.projection === "toolCall")).toHaveLength(5_000);
    expect(bound["toolCall:4999"]?.payload).toMatchObject({ projection: "toolCall", record: { message_id: "message", status: "completed" }, identity: "native-child" });
    expect(bound.foreign).toBe(foreign);
    expect(items["toolCall:4999"]?.payload.projection).toBe("narrativeRecovery");
    expect(bound["toolCall:4999"]?.updatedAt).toBe(END);
  });

  it("settles unfinished tools and hooks and classifies the final thought from its accepted message", () => {
    const values = [item("tool", "toolCall", { status: "running", completed_at: null }),
      item("hook", "hook", { started_at: NOW, ended_at: null, duration_ms: null }),
      item("thought", "narrationSegment", { text: "Answer", sort_order: 2, is_final_response: 0 }),
      item("older", "narrationSegment", { text: "Planning", sort_order: 1, is_final_response: 0 })];
    const items = Object.fromEntries(values.map((value) => [value.id, value]));
    items["message:message"] = { ...values[0]!, id: "message:message", kind: "message",
      payload: { projection: "message", message: { content: "Answer" } } };
    const bound = bindResponseItems(items, input);
    expect(bound.tool?.payload.record).toMatchObject({ status: "failed", completed_at: END });
    expect(bound.hook?.payload.record).toMatchObject({ ended_at: END, duration_ms: 3_000 });
    expect(bound.thought?.payload.record).toMatchObject({ is_final_response: 1 });
    expect(bound.older?.payload.record).toMatchObject({ is_final_response: 0 });
  });
});
