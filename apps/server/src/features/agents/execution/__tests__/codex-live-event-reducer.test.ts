import { describe, expect, it } from "vitest";
import { AgentEventSchema, type AgentEvent } from "@mcode/contracts";
import { CodexEventMapper } from "../../../../../../../packages/providers/src/private/codex/codex-event-mapper.js";
import { CodexLiveEventReducer } from "../codex-live-event-reducer.js";

const execution = {
  threadId: "test-thread",
  turnId: "test-turn",
  executionId: "11111111-1111-4111-8111-111111111111",
};

function event(type: AgentEvent["type"], fields: Record<string, unknown> = {}): AgentEvent {
  return AgentEventSchema().parse({ type, threadId: execution.threadId, ...fields });
}

describe("CodexLiveEventReducer", () => {
  it("reduces a Codex notification sequence through tool narration and final answer", () => {
    const mapper = new CodexEventMapper(execution.threadId);
    const reducer = new CodexLiveEventReducer(execution);
    const reductions = [reducer.reduce(event("turnStarted"))];
    const notifications = [
      { method: "item/agentMessage/delta", params: { itemId: "thought", delta: "I will check." } },
      { method: "item/completed", params: { item: { type: "agentMessage", id: "thought" } } },
      { method: "item/started", params: { item: { type: "commandExecution", id: "cmd", command: "pwd" } } },
      { method: "item/completed", params: { item: { type: "commandExecution", id: "cmd", command: "pwd", output: "/repo", exitCode: 0 } } },
      { method: "item/agentMessage/delta", params: { itemId: "answer", delta: "Done." } },
      { method: "item/completed", params: { item: { type: "agentMessage", id: "answer" } } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    ];
    for (const notification of notifications) {
      for (const runtimeEvent of mapper.mapNotification({ jsonrpc: "2.0", ...notification })) {
        reductions.push(reducer.reduce(runtimeEvent.event));
      }
    }

    expect(reductions.every((result) => result.kind === "reduced")).toBe(true);
    const reduced = reductions.filter((result) => result.kind === "reduced");
    expect(reduced.map((result) => result.publication.event.type)).toEqual([
      "turnStarted", "textDelta", "assistantMessageBoundary", "toolUse", "toolResult",
      "textDelta", "assistantMessageBoundary", "message", "turnComplete",
    ]);
    const toolUse = reduced.find((result) => result.publication.event.type === "toolUse");
    expect(toolUse?.writer).toContainEqual(expect.objectContaining({ kind: "tool-use" }));
    const message = reduced.find((result) => result.publication.event.type === "message");
    expect(message?.writer).toContainEqual(expect.objectContaining({
      kind: "assistant-body", content: "Done.", attachments: [],
    }));
    const terminal = reduced.find((result) => result.publication.event.type === "turnComplete");
    expect(terminal?.writer).toContainEqual(expect.objectContaining({
      kind: "terminal-projection", source: "turnComplete", outcome: "completed",
      assistant: expect.objectContaining({ content: "Done." }),
    }));
    expect(terminal?.publication.after).toBe("terminal");
    expect(structuredClone(reduced)).toEqual(reduced);
  });

  it("reclassifies unknown text as narration and carries attachments and late hooks", () => {
    const reducer = new CodexLiveEventReducer(execution);
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    const delta = reducer.reduce(event("textDelta", { delta: "working" }));
    expect(delta.kind).toBe("reduced");
    if (delta.kind !== "reduced") return;
    expect(delta.writer).toContainEqual({ kind: "assistant-text-delta", delta: "working", classification: "unknown" });
    const boundary = reducer.reduce(event("assistantMessageBoundary", { isFinalResponse: false }));
    expect(boundary.kind).toBe("reduced");
    if (boundary.kind !== "reduced") return;
    expect(boundary.writer).toContainEqual({ kind: "assistant-text-reclassify", text: "working", classification: "narration" });
    expect(boundary.writer).toContainEqual(expect.objectContaining({
      kind: "narrative-recovery",
      items: [expect.objectContaining({ kind: "narrationSegment", record: expect.objectContaining({ text: "working" }) })],
    }));

    const attachment = { id: "image", name: "image.png", mimeType: "image/png", sizeBytes: 12 };
    expect(reducer.reduce(event("generatedAttachment", { attachment })).kind).toBe("reduced");
    const message = reducer.reduce(event("message", { content: "Answer", tokens: null }));
    expect(message.kind).toBe("reduced");
    if (message.kind !== "reduced") return;
    expect(message.writer).toContainEqual(expect.objectContaining({ kind: "assistant-body", attachments: [attachment] }));

    expect(reducer.reduce(event("turnComplete", { reason: "completed", costUsd: null, tokensIn: 2, tokensOut: 1 })).kind).toBe("reduced");
    const started = reducer.reduce(event("hookStarted", { hookName: "stop", hookType: "stop" }));
    expect(started.kind).toBe("reduced");
    if (started.kind !== "reduced") return;
    expect(started.writer).toContainEqual(expect.objectContaining({ kind: "hook-started", late: true }));
    const completed = reducer.reduce(event("hookCompleted", { hookName: "stop", exitCode: 0, durationMs: 10, didBlock: false }));
    expect(completed.kind).toBe("reduced");
    if (completed.kind !== "reduced") return;
    expect(completed.writer).toContainEqual(expect.objectContaining({ kind: "hook-completed", late: true }));
    expect(completed.publication.after).toBe("terminal");
  });

  it("rejects another execution and unowned events without changing the active execution", () => {
    const reducer = new CodexLiveEventReducer(execution);
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    expect(reducer.reduce(event("textDelta", { delta: "wrong", turnExecutionId: "22222222-2222-4222-8222-222222222222" }))).toEqual({
      kind: "unsupported", eventType: "textDelta", reason: "different execution",
    });
    expect(reducer.reduce(event("goalCleared", { reason: "cleared" }))).toEqual({
      kind: "unsupported", eventType: "goalCleared", reason: "event needs a separate feature owner",
    });
    const final = reducer.reduce(event("textDelta", { delta: "right", isFinalResponse: true }));
    expect(final.kind).toBe("reduced");
    if (final.kind !== "reduced") return;
    expect(final.writer).toContainEqual({ kind: "assistant-text-delta", delta: "right", classification: "final" });
  });
});
