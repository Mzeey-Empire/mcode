import { describe, expect, it } from "vitest";
import { AgentEventSchema } from "@mcode/contracts";
import { CodexEventMapper } from "../../private/codex/codex-event-mapper.js";

function map(mapper: CodexEventMapper, method: string, params: Record<string, unknown>) {
  return mapper.mapNotification({ jsonrpc: "2.0", method, params }).map(({ event }) => event);
}
function completed(mapper: CodexEventMapper, id: string, text: string, phase?: unknown) {
  return map(mapper, "item/completed", { item: { id, type: "agentMessage", text, phase } });
}
function terminal(mapper: CodexEventMapper, status = "completed") {
  return map(mapper, "turn/completed", { turn: { status } });
}

describe("Codex assistant item lifecycle", () => {
  it("streams native final phase into the response and closes it before turn completion", () => {
    const mapper = new CodexEventMapper("thread");
    map(mapper, "item/started", { item: { type: "agentMessage", id: "final", phase: "final_answer" } });
    const deltas = map(mapper, "item/agentMessage/delta", { itemId: "final", delta: "Done" });
    const closed = completed(mapper, "final", "Done", "final_answer");
    expect(deltas).toMatchObject([{ type: "textDelta", isFinalResponse: true }]);
    expect(closed).toMatchObject([
      { type: "assistantMessageBoundary", content: "Done", isFinalResponse: true },
      { type: "message", content: "Done" },
    ]);
    const delta = deltas[0]; const boundary = closed[0];
    if (delta?.type !== "textDelta" || boundary?.type !== "assistantMessageBoundary") throw new Error("Missing text lifecycle");
    expect(boundary.textItemId).toBe(delta.textItemId);
    for (const event of [...deltas, ...closed]) expect(AgentEventSchema().parse(event)).toEqual(event);
    expect(closed.some((event) => event.type === "turnComplete" || event.type === "ended")).toBe(false);
    expect(completed(mapper, "final", "Done", "final_answer")).toEqual([]);
    expect(map(mapper, "item/agentMessage/delta", { itemId: "final", delta: " late" })).toEqual([]);
    expect(terminal(mapper).map((event) => event.type)).toEqual(["message", "turnComplete"]);
  });

  it.each(["short", "different", ""])("reconciles authoritative completed content %j", (text) => {
    const mapper = new CodexEventMapper("thread");
    map(mapper, "item/agentMessage/delta", { itemId: "item", delta: "streamed text" });
    expect(completed(mapper, "item", text, "commentary")).toMatchObject([
      { type: "assistantMessageBoundary", content: text, isFinalResponse: false },
    ]);
    expect(terminal(mapper).map((event) => event.type)).toEqual(["turnComplete"]);
  });

  it("closes phase-less text now and promotes only its exact identity at success", () => {
    const mapper = new CodexEventMapper("thread");
    const first = completed(mapper, "first", "Same");
    map(mapper, "item/started", { item: { id: "tool", type: "commandExecution" } });
    const last = completed(mapper, "last", "Same");
    expect(first.at(-1)).toMatchObject({ type: "assistantMessageBoundary", isFinalResponse: false });
    const lastBoundary = last.at(-1);
    if (lastBoundary?.type !== "assistantMessageBoundary") throw new Error("Missing closure");
    const success = terminal(mapper);
    expect(success[0]).toMatchObject({ type: "assistantMessageBoundary", textItemId: lastBoundary.textItemId, content: "Same", isFinalResponse: true });
    const firstBoundary = first.at(-1);
    if (firstBoundary?.type !== "assistantMessageBoundary") throw new Error("Missing first closure");
    expect(lastBoundary.textItemId).not.toBe(firstBoundary.textItemId);
  });

  it("accepts delayed native completion for text already closed by later work", () => {
    const mapper = new CodexEventMapper("thread");
    map(mapper, "item/agentMessage/delta", { itemId: "old", delta: "incorrect" });
    map(mapper, "item/started", { item: { id: "tool", type: "commandExecution" } });
    const newer = completed(mapper, "new", "Latest");
    expect(completed(mapper, "old", "Corrected", "commentary")).toMatchObject([
      { type: "assistantMessageBoundary", content: "Corrected", isFinalResponse: false },
    ]);
    const last = newer.at(-1);
    if (last?.type !== "assistantMessageBoundary") throw new Error("Missing last boundary");
    expect(terminal(mapper)[0]).toMatchObject({ type: "assistantMessageBoundary", textItemId: last.textItemId });
  });

  it("preserves a known final answer over later unknown or explicit commentary", () => {
    const mapper = new CodexEventMapper("thread");
    completed(mapper, "answer", "Answer", "final_answer");
    completed(mapper, "unknown", "Later narration", "future-phase");
    expect(terminal(mapper)).toMatchObject([{ type: "message", content: "Answer" }, { type: "turnComplete" }]);
  });

  it.each(["failed", "interrupted"])("does not success-promote closed narration on %s", (status) => {
    const mapper = new CodexEventMapper("thread");
    completed(mapper, "item", "Narration");
    expect(terminal(mapper, status).some((event) => event.type === "message" || event.type === "turnComplete"
      || (event.type === "assistantMessageBoundary" && event.isFinalResponse))).toBe(false);
  });

  it.each(["item/started", "item/agentMessage/delta"])("keeps an ID-less stream identity when %s later supplies its native ID", (method) => {
    const mapper = new CodexEventMapper("thread");
    const first = map(mapper, "item/agentMessage/delta", { delta: "Hello" })[0];
    map(mapper, method, method === "item/started"
      ? { item: { type: "agentMessage", id: "native-id" } }
      : { itemId: "native-id", delta: " world" });
    const boundary = completed(mapper, "native-id", "Hello world").at(-1);
    if (first?.type !== "textDelta" || boundary?.type !== "assistantMessageBoundary") throw new Error("Missing text");
    expect(boundary.textItemId).toBe(first.textItemId);
  });

  it("reconciles a changed completion without reopening or appending its text", () => {
    const mapper = new CodexEventMapper("thread");
    const first = completed(mapper, "item", "Original");
    const corrected = completed(mapper, "item", "New", "final_answer");
    expect(corrected).toMatchObject([
      { type: "assistantMessageBoundary", isFinalResponse: true, content: "New" },
      { type: "message", content: "New" },
    ]);
    const previous = first.at(-1); const updated = corrected[0];
    if (previous?.type !== "assistantMessageBoundary" || updated?.type !== "assistantMessageBoundary") throw new Error("Missing closure");
    expect(updated.textItemId).toBe(previous.textItemId);
  });

  it("retains a closed known answer while trailing unknown text is still open", () => {
    const mapper = new CodexEventMapper("thread");
    completed(mapper, "answer", "Known", "final_answer");
    map(mapper, "item/agentMessage/delta", { itemId: "unknown", delta: "Trailing" });
    expect(terminal(mapper)).toMatchObject([
      { type: "assistantMessageBoundary", isFinalResponse: false, content: "Trailing" },
      { type: "message", content: "Known" }, { type: "turnComplete" },
    ]);
  });

  it("uses a different identity for a reused native item on another delivery attempt", () => {
    const mapper = new CodexEventMapper("thread");
    mapper.prepareForTurn({ executionId: "execution", deliveryAttempt: 1 });
    const first = completed(mapper, "same-id", "Done").at(-1);
    mapper.prepareForTurn({ executionId: "execution", deliveryAttempt: 2 });
    const second = completed(mapper, "same-id", "Done").at(-1);
    if (first?.type !== "assistantMessageBoundary" || second?.type !== "assistantMessageBoundary") throw new Error("Missing boundary");
    expect(first.textItemId).not.toBe(second.textItemId);
  });
});
