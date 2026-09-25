import { describe, expect, it } from "vitest";
import { AgentEventSchema, type AgentEvent } from "@mcode/contracts";
import { CodexLiveEventReducer, type CodexPlanFeature } from "../codex-live-event-reducer.js";
import { CodexLiveEventEffects } from "../codex-live-event-effects.js";
import { deriveTurnAssistantMessageId } from "../../turns/turn-assistant-message-id.js";

const execution = { threadId: "thread", turnId: "turn", executionId: "11111111-1111-4111-8111-111111111111" };
const endedAt = "2026-09-25T12:00:00.000Z";

function event(type: AgentEvent["type"], fields: Record<string, unknown> = {}): AgentEvent {
  return AgentEventSchema().parse({ type, threadId: execution.threadId, turnExecutionId: execution.executionId, ...fields });
}

function setup(plan: CodexPlanFeature = "none") {
  const reducer = new CodexLiveEventReducer(execution, plan);
  const mapper = new CodexLiveEventEffects(execution, "user-message");
  const prepare = (type: AgentEvent["type"], fields: Record<string, unknown> = {}) => {
    const reduction = reducer.reduce(event(type, fields));
    if (reduction.kind !== "reduced") throw new Error(reduction.reason);
    return mapper.prepare(reduction, endedAt);
  };
  prepare("turnStarted");
  return { prepare, mapper };
}

describe("CodexLiveEventEffects", () => {
  it("moves unknown text into narrative and restarts its checkpoint sequence", () => {
    const { prepare } = setup();
    expect(prepare("textDelta", { delta: "Looking at the files" }).effects.text).toEqual({
      kind: "append", inputs: [{ ...execution, sequence: 1, text: "Looking at the files" }],
    });
    const boundary = prepare("assistantMessageBoundary", { isFinalResponse: false });
    expect(boundary.effects.text).toEqual({ kind: "reclassify", expectedText: "Looking at the files" });
    expect(boundary.effects.narrative?.items).toEqual([
      expect.objectContaining({ kind: "narrationSegment", record: expect.objectContaining({ text: "Looking at the files" }) }),
    ]);
    expect(prepare("textDelta", { delta: "Fixed", isFinalResponse: true }).effects.text).toEqual({
      kind: "append", inputs: [{ ...execution, sequence: 1, text: "Fixed" }],
    });
  });

  it("promotes narration while deleting its old recovery record", () => {
    const { prepare } = setup();
    const thought = prepare("textDelta", { delta: "Answer", isFinalResponse: false });
    const id = thought.effects.narrative?.items[0]?.record.id;
    expect(id).toBeDefined();
    const promoted = prepare("assistantMessageBoundary", { isFinalResponse: true });
    expect(promoted.effects.text).toEqual({ kind: "promote", input: { ...execution, sequence: 1, text: "Answer" } });
    expect(promoted.effects.narrative?.discardedItemIds).toEqual([`narrationSegment:${id}`]);
  });

  it("retains TaskCreate input until its result and keeps file intents separate", () => {
    const { prepare } = setup();
    const use = prepare("toolUse", { toolCallId: "create", toolName: "TaskCreate", toolInput: { subject: "Fix login" } });
    expect(use.runtime).toContainEqual(expect.objectContaining({ kind: "tool-use" }));
    expect(use.effects.narrative?.items[0]?.kind).toBe("toolCall");
    const result = prepare("toolResult", { toolCallId: "create", output: "Task #42 created", isError: false });
    expect(result.effects.taskIntents).toEqual([
      { kind: "append-task", task: { id: "42", content: "Fix login", status: "pending", group: "Tasks" } },
    ]);
  });

  it("carries system intents and leaves context projection explicit", () => {
    const { prepare } = setup();
    const system = prepare("system", { subtype: "sdk_session_id:session-1" });
    expect(system.effects.systemIntents).toEqual([{ kind: "session-cursor", event: system.publication.event }]);
    const context = prepare("contextEstimate", { tokensIn: 120, totalProcessedTokens: 120, contextWindow: 1000 });
    expect(context.runtime).toEqual([{ kind: "context-usage", tokensIn: 120, contextWindow: 1000 }]);
  });

  it("uses the same assigned assistant identity for live and terminal data", () => {
    const { prepare } = setup();
    prepare("textDelta", { delta: "Answer", isFinalResponse: true });
    const message = prepare("message", { content: "Answer", tokens: null });
    const messageId = deriveTurnAssistantMessageId(execution.threadId, "user-message");
    expect(message.effects.message).toMatchObject({ precedingMessageId: "user-message", messageId, content: "Answer" });
    expect(message.publication.event).toMatchObject({ type: "message", messageId });
    const terminal = prepare("error", { error: "Provider disconnected" });
    expect(terminal.terminal).toMatchObject({ threadId: execution.threadId, executionId: execution.executionId,
      endedAt, outcome: "errored", assistant: { messageId, content: "Answer" } });
    expect(terminal.publication.after).toBe("terminal");
    expect(terminal.runtime).toContainEqual({ kind: "turn-error", error: "Provider disconnected" });
    expect(structuredClone(terminal)).toEqual(terminal);
  });

  it("carries parsed plan questions with their completing text event", () => {
    const { prepare } = setup("questions");
    const question = { id: "q1", category: "AUTH", question: "Which login?", options: [
      { id: "o1", title: "Passkey", description: "Use passkeys.", recommended: true },
      { id: "o2", title: "Password", description: "Use passwords." },
    ] };
    const text = `\`\`\`plan-questions\n${JSON.stringify([question])}\n\`\`\``;
    const result = prepare("textDelta", { delta: text });
    expect(result.effects.planQuestions).toEqual([question]);
    expect(result.effects.text.kind).toBe("append");
    expect(result.publication.after).toBe("writer");
  });

  it("rejects another execution before advancing checkpoint state", () => {
    const { mapper, prepare } = setup();
    const other = new CodexLiveEventReducer({ ...execution, turnId: "other-turn" });
    const reduction = other.reduce(event("turnStarted"));
    if (reduction.kind !== "reduced") throw new Error(reduction.reason);
    expect(() => mapper.prepare(reduction)).toThrow("another execution");
    expect(prepare("textDelta", { delta: "Answer" }).effects.text).toMatchObject({ inputs: [{ sequence: 1 }] });
  });

  it("associates parsed plan output with the staged assistant body", () => {
    const { prepare } = setup("output");
    const plan = { title: "Login plan", sections: [
      { id: "s1", title: "Implementation", level: 1, content: "Add passkey login." },
    ] };
    prepare("textDelta", { delta: `\`\`\`plan-output\n${JSON.stringify(plan)}\n\`\`\`` });
    const result = prepare("message", { content: "Provider prose", tokens: null });
    expect(result.effects.planOutput).toEqual({ title: "Login plan",
      contentMd: "## Implementation\n\nAdd passkey login.",
      sectionsJson: '[{"id":"s1","title":"Implementation","level":1}]', changeSummary: null });
    expect(result.effects.message?.content).toBe("Provider prose");
    expect(result.publication.event).toMatchObject({ messageId: result.effects.message?.messageId });
  });
});
