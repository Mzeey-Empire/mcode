import { describe, expect, it } from "vitest";
import { AgentEventSchema, type AgentEvent, type ProviderRuntimeEvent } from "@mcode/contracts";
import type { ProviderEventDraft } from "@mcode/providers";
import { CodexEventMapper } from "../../../../../../../packages/providers/src/private/codex/codex-event-mapper.js";
import { CodexLiveEventReducer } from "../codex-live-event-reducer.js";
import { ProviderExecutionEventState } from "../provider-execution-event-state.js";

const execution = {
  threadId: "test-thread",
  turnId: "test-turn",
  executionId: "11111111-1111-4111-8111-111111111111",
};

function event(type: AgentEvent["type"], fields: Record<string, unknown> = {}): AgentEvent {
  return AgentEventSchema().parse({ type, threadId: execution.threadId, turnExecutionId: execution.executionId, ...fields });
}

function boundByProvider(mapped: AgentEvent): AgentEvent {
  return { ...mapped, turnExecutionId: execution.executionId };
}

function reduceEvent(reducer: CodexLiveEventReducer, type: AgentEvent["type"], fields: Record<string, unknown> = {}) {
  const reduction = reducer.reduce(event(type, fields));
  if (reduction.kind !== "reduced") throw new Error(reduction.reason);
  return reduction;
}

function runtimeDraft(input: AgentEvent, sequence: number, planCapture?: ProviderRuntimeEvent["planCapture"]): ProviderEventDraft {
  const timestamp = "2026-09-30T10:00:00.000Z";
  const itemId = `runtime:${sequence}`;
  return { eventId: `provider:${sequence}`, routing: { ...execution, itemId },
    sourceProviderId: "codex", sourceIdentities: [], sourceSequence: sequence,
    payload: { type: "item.recorded", item: {
      id: itemId, threadId: execution.threadId, turnId: execution.turnId,
      kind: "system", providerIdentities: [], payload: { projection: "providerRuntimeEvent", runtimeEvent: { event: input, ...(planCapture ? { planCapture } : {}) } },
      createdAt: timestamp, updatedAt: timestamp,
    } } };
}

function prepareCandidate(accepted: ProviderExecutionEventState, input: AgentEvent, sequence: number, terminal = false) {
  const candidate = accepted.fork();
  const prepared = candidate.prepare([runtimeDraft(input, sequence)], terminal);
  if (prepared.kind !== "parent") throw new Error(`Expected parent preparation, received ${prepared.kind}`);
  return { candidate, prepared: prepared.prepared };
}

describe("CodexLiveEventReducer", () => {
  it.each(["boundary", "tool", "text-item"])("settles a closing plan fence before the next %s", (boundary) => {
    const reducer = new CodexLiveEventReducer(execution, "output");
    const firstItem = `assistant-text:${"a".repeat(64)}`;
    const nextItem = `assistant-text:${"b".repeat(64)}`;
    reduceEvent(reducer, "turnStarted");
    reduceEvent(reducer, "textDelta", { delta: "````mcode-plan\n## Native-sized plan\n````", textItemId: firstItem, isFinalResponse: false });
    if (boundary === "boundary") reduceEvent(reducer, "assistantMessageBoundary", { textItemId: firstItem, isFinalResponse: false });
    if (boundary === "tool") reduceEvent(reducer, "toolUse", { toolCallId: "read", toolName: "Read", toolInput: {} });
    reduceEvent(reducer, "textDelta", { delta: "Summary.", textItemId: boundary === "text-item" ? nextItem : firstItem, isFinalResponse: false });
    const message = reduceEvent(reducer, "message", { content: "Summary.", tokens: null });
    expect(message.writer).toContainEqual({ kind: "plan-captured", output: {
      title: "Native-sized plan", contentMd: "## Native-sized plan",
      captureSource: "fence",
    } });
  });

  it.each(["none", "questions", "output"] as const)("reports missing only for an armed completed %s turn", (feature) => {
    const reducer = new CodexLiveEventReducer(execution, feature);
    reduceEvent(reducer, "turnStarted");
    reducer.reduce(event("message", { content: "Summary", tokens: null }), { source: "native", markdown: " " });
    const result = reduceEvent(reducer, "turnComplete", { providerId: "codex", reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    expect(result.writer.filter((intent) => intent.kind === "plan-capture-outcome")).toEqual(
      feature === "output" ? [{ kind: "plan-capture-outcome", outcome: "missing" }] : [],
    );
  });

  it.each(["cancelled", "interrupted", "errored"] as const)("does not report a missing plan for %s", (outcome) => {
    const reducer = new CodexLiveEventReducer(execution, "output");
    reduceEvent(reducer, "turnStarted");
    const result = reducer.finishFromState(outcome === "errored" ? { outcome, error: "failed" } : { outcome });
    if (result.kind !== "reduced") throw new Error(result.reason);
    expect(result.writer.filter((intent) => intent.kind === "plan-capture-outcome")).toEqual([]);
  });

  it("reports captured from worker state without a server callback", () => {
    const reducer = new CodexLiveEventReducer(execution, "output");
    reduceEvent(reducer, "turnStarted");
    reduceEvent(reducer, "message", { content: "````mcode-plan\n# Plan\n````", tokens: null });
    const result = reduceEvent(reducer, "turnComplete", { providerId: "codex", reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    expect(result.writer).toContainEqual({ kind: "plan-capture-outcome", outcome: "captured" });
  });

  it.each(["claude", "cursor"])("materializes %s native capture through the worker, ahead of its fence", (providerId) => {
    const state = new ProviderExecutionEventState(providerId, execution, { precedingMessageId: "user", planFeature: "output" });
    state.startFromAdmission();
    const draft = runtimeDraft(event("message", { content: "````mcode-plan\n# Fence plan\n````", tokens: null }), 1,
      { markdown: "# Native plan\n## Build\nShip it.", source: "native" });
    const result = state.prepare([{ ...draft, sourceProviderId: providerId }]);
    if (result.kind !== "parent") throw new Error("Native capture was rejected");
    expect(result.prepared.effects.planOutput).toEqual({
      title: "Native plan", contentMd: "# Native plan\n## Build\nShip it.",
      captureSource: "native",
    });
    const duplicate = state.prepare([{ ...runtimeDraft(event("message", { content: "# More prose", tokens: null }), 2), sourceProviderId: providerId }]);
    if (duplicate.kind !== "parent") throw new Error("Follow-up message was rejected");
    expect(duplicate.prepared.effects.planOutput).toBeUndefined();
  });
  it("prepares more than 1000 completed tools through the public parent path and retains full terminal history", () => {
    let accepted = new ProviderExecutionEventState("codex", execution, { precedingMessageId: "user", planFeature: "none" });
    const start = prepareCandidate(accepted, event("turnStarted"), 1);
    accepted = start.candidate;
    const count = 1100;
    for (let index = 0; index < count; index += 1) {
      const toolCallId = `tool-${index}`;
      const use = prepareCandidate(accepted, event("toolUse", { toolCallId, toolName: "Read",
        toolInput: { file_path: `${toolCallId}.txt` } }), index * 2 + 2);
      expect(use.prepared.effects.narrative?.items.map((item) => item.record.id)).toEqual([toolCallId]);
      accepted = use.candidate;
      const result = prepareCandidate(accepted, event("toolResult", { toolCallId, output: `output-${index}`, isError: false }), index * 2 + 3);
      expect(result.prepared.effects.narrative?.items).toMatchObject([
        { kind: "toolCall", record: { id: toolCallId, status: "completed", output_summary: `output-${index}` } },
      ]);
      expect(result.prepared.effects.narrative?.discardedItemIds).toEqual([]);
      accepted = result.candidate;
    }
    const thought = prepareCandidate(accepted, event("textDelta", { delta: "After the tools", isFinalResponse: false }), count * 2 + 2);
    expect(thought.prepared.effects.narrative?.items).toMatchObject([
      { kind: "narrationSegment", record: { text: "After the tools" } },
    ]);
    accepted = thought.candidate;
    const terminal = prepareCandidate(accepted, event("turnComplete", { reason: "completed", costUsd: null,
      tokensIn: 0, tokensOut: 0 }), count * 2 + 3, true);
    const history = terminal.prepared.terminal?.narrative;
    expect(history).toHaveLength(count + 1);
    expect(history?.filter((item) => item.kind === "toolCall").map((item) => item.record.id))
      .toEqual(Array.from({ length: count }, (_, index) => `tool-${index}`));
    expect(history?.filter((item) => item.kind === "toolCall").every((item) => item.record.status === "completed")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(history), "utf8")).toBeGreaterThan(256 * 1024);
  }, 30_000);

  it("does not install rejected tool completion or thought removal into accepted parent state", () => {
    let accepted = new ProviderExecutionEventState("codex", execution, { precedingMessageId: "user", planFeature: "none" });
    accepted = prepareCandidate(accepted, event("turnStarted"), 1).candidate;
    accepted = prepareCandidate(accepted, event("toolUse", { toolCallId: "tool", toolName: "Read", toolInput: { file_path: "a.txt" } }), 2).candidate;
    const rejected = prepareCandidate(accepted, event("toolResult", { toolCallId: "tool", output: "rejected", isError: false }), 3);
    expect(rejected.prepared.effects.narrative?.items[0]?.record).toMatchObject({ status: "completed", output_summary: "rejected" });
    const terminal = prepareCandidate(accepted, event("turnComplete", { reason: "completed", costUsd: null,
      tokensIn: 0, tokensOut: 0 }), 4, true);
    expect(terminal.prepared.terminal?.narrative[0]?.record).toMatchObject({ status: "running", output_summary: "" });
    const thought = prepareCandidate(accepted, event("textDelta", { delta: "Keep this", isFinalResponse: false }), 5);
    accepted = thought.candidate;
    const thoughtId = thought.prepared.effects.narrative?.items[0]?.record.id;
    const removed = prepareCandidate(accepted, event("assistantMessageBoundary", { isFinalResponse: true }), 6);
    expect(removed.prepared.effects.narrative?.discardedItemIds).toEqual([`narrationSegment:${thoughtId}`]);
    const retry = prepareCandidate(accepted, event("textDelta", { delta: " too", isFinalResponse: false }), 7);
    expect(retry.prepared.effects.narrative?.items).toMatchObject([
      { kind: "narrationSegment", record: { id: thoughtId, text: "Keep this too" } },
    ]);
  });

  it.each([false, true])("keeps rejected closed-item correction isolated when final placement is %s", (isFinalResponse) => {
    const textItemId = `assistant-text:${"a".repeat(64)}`;
    let accepted = new ProviderExecutionEventState("codex", execution, { precedingMessageId: "user", planFeature: "none" });
    accepted = prepareCandidate(accepted, event("turnStarted"), 1).candidate;
    accepted = prepareCandidate(accepted, event("textDelta", { textItemId, delta: "Original", isFinalResponse: false }), 2).candidate;
    accepted = prepareCandidate(accepted, event("assistantMessageBoundary", { textItemId, content: "Original", isFinalResponse: false }), 3).candidate;
    const correction = prepareCandidate(accepted, event("assistantMessageBoundary", { textItemId, content: "Corrected", isFinalResponse }), 4);
    const terminal = event("turnComplete", { reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    const rejected = prepareCandidate(accepted, terminal, 5, true);
    expect(rejected.prepared.terminal?.narrative).toMatchObject([
      { kind: "narrationSegment", record: { id: textItemId, text: "Original", is_final_response: 0 } },
    ]);
    const installed = prepareCandidate(correction.candidate, terminal, 5, true);
    if (isFinalResponse) {
      expect(installed.prepared.terminal?.narrative).toEqual([]);
      expect(installed.prepared.terminal?.assistant.content).toBe("Corrected");
    } else {
      expect(installed.prepared.terminal?.narrative).toMatchObject([
        { kind: "narrationSegment", record: { id: textItemId, text: "Corrected", is_final_response: 0 } },
      ]);
    }
  });

  it("returns only changed recovery items and retains the complete terminal snapshot", () => {
    const reducer = new CodexLiveEventReducer(execution);
    reduceEvent(reducer, "turnStarted");
    reduceEvent(reducer, "toolUse", { toolCallId: "first", toolName: "Read", toolInput: { file_path: "one" } });
    const second = reduceEvent(reducer, "toolUse", { toolCallId: "second", toolName: "Read", toolInput: { file_path: "two" } });
    expect(second.writer).toContainEqual({ kind: "narrative-recovery", discardedItemIds: [],
      items: [expect.objectContaining({ kind: "toolCall", record: expect.objectContaining({ id: "second" }) })] });
    const result = reduceEvent(reducer, "toolResult", { toolCallId: "first", output: "contents", isError: false });
    expect(result.writer).toContainEqual({ kind: "narrative-recovery", discardedItemIds: [],
      items: [expect.objectContaining({ kind: "toolCall", record: expect.objectContaining({ id: "first", output_summary: "contents" }) })] });
    const boundary = reduceEvent(reducer, "assistantMessageBoundary", { isFinalResponse: false });
    expect(boundary.writer).toContainEqual({ kind: "narrative-recovery", items: [], discardedItemIds: [] });
    const terminal = reduceEvent(reducer, "turnComplete", { reason: "stop", costUsd: 0, tokensIn: 0, tokensOut: 0 });
    const projection = terminal.writer.find((intent) => intent.kind === "terminal-projection");
    expect(projection?.narrative.map((item) => item.record.id)).toEqual(["first", "second"]);
    const lateHook = reduceEvent(reducer, "hookStarted", { hookName: "stop", hookType: "stop" });
    expect(lateHook.writer).toContainEqual({ kind: "narrative-recovery", discardedItemIds: [],
      items: [expect.objectContaining({ kind: "hook" })] });
  });

  it("keeps recovery output independent of buffered state and emits discard-only deltas", () => {
    const reducer = new CodexLiveEventReducer(execution);
    reduceEvent(reducer, "turnStarted");
    const thought = reduceEvent(reducer, "textDelta", { delta: "Answer", isFinalResponse: false });
    const item = thought.writer.find((intent) => intent.kind === "narrative-recovery")?.items[0];
    if (item?.kind !== "narrationSegment") throw new Error("Expected narration recovery");
    const id = item.record.id;
    item.record.text = "Mutated caller copy";
    const extended = reduceEvent(reducer, "textDelta", { delta: " continues", isFinalResponse: false });
    expect(extended.writer).toContainEqual({ kind: "narrative-recovery", discardedItemIds: [],
      items: [expect.objectContaining({ record: expect.objectContaining({ id, text: "Answer continues" }) })] });
    expect(item.record.text).toBe("Mutated caller copy");
    const promoted = reduceEvent(reducer, "assistantMessageBoundary", { isFinalResponse: true });
    expect(promoted.writer).toContainEqual({ kind: "narrative-recovery", items: [], discardedItemIds: [`narrationSegment:${id}`] });
    expect(promoted.writer).toContainEqual({ kind: "assistant-text-promote", text: "Answer continues" });
    const repeated = reduceEvent(reducer, "assistantMessageBoundary", { isFinalResponse: true });
    expect(repeated.writer).toContainEqual({ kind: "narrative-recovery", items: [], discardedItemIds: [] });
  });

  it("promotes only the selected closed item when different items have identical text", () => {
    const reducer = new CodexLiveEventReducer(execution);
    const firstId = `assistant-text:${"1".repeat(64)}`;
    const finalId = `assistant-text:${"2".repeat(64)}`;
    reduceEvent(reducer, "turnStarted");
    for (const textItemId of [firstId, finalId]) {
      reduceEvent(reducer, "textDelta", { textItemId, delta: "Same", isFinalResponse: false });
      reduceEvent(reducer, "assistantMessageBoundary", { textItemId, content: "Same", isFinalResponse: false });
    }
    const promotion = reduceEvent(reducer, "assistantMessageBoundary", { textItemId: finalId, content: "Corrected", isFinalResponse: true });
    expect(promotion.writer).toContainEqual({ kind: "assistant-text-promote", text: "Corrected" });
    expect(promotion.writer).toContainEqual({ kind: "narrative-recovery", items: [], discardedItemIds: [`narrationSegment:${finalId}`] });
    const repeated = reduceEvent(reducer, "assistantMessageBoundary", { textItemId: finalId, content: "Corrected", isFinalResponse: true });
    expect(repeated.writer.some((intent) => intent.kind === "assistant-text-promote")).toBe(false);
    reduceEvent(reducer, "message", { content: "Same", tokens: null });
    const terminal = reduceEvent(reducer, "turnComplete", { reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    const narrative = terminal.writer.find((intent) => intent.kind === "terminal-projection")?.narrative;
    expect(narrative).toMatchObject([{ kind: "narrationSegment", record: { id: firstId, text: "Same", is_final_response: 0 } }]);
  });

  it("reconciles shortened completed narration and does not reopen it from a late delta", () => {
    const reducer = new CodexLiveEventReducer(execution);
    const textItemId = `assistant-text:${"3".repeat(64)}`;
    reduceEvent(reducer, "turnStarted");
    reduceEvent(reducer, "textDelta", { textItemId, delta: "Long incorrect text", isFinalResponse: false });
    const closed = reduceEvent(reducer, "assistantMessageBoundary", { textItemId, content: "Short", isFinalResponse: false });
    expect(closed.writer).toContainEqual({ kind: "narrative-recovery", discardedItemIds: [], items: [
      expect.objectContaining({ kind: "narrationSegment", record: expect.objectContaining({ id: textItemId, text: "Short", ended_at: expect.any(String) }) }),
    ] });
    const late = reduceEvent(reducer, "textDelta", { textItemId, delta: " late", isFinalResponse: false });
    expect(late.writer).toContainEqual({ kind: "narrative-recovery", items: [], discardedItemIds: [] });
  });

  it("keeps execution nonterminal when native final item materializes a full body", () => {
    const mapper = new CodexEventMapper(execution.threadId);
    const reducer = new CodexLiveEventReducer(execution);
    reduceEvent(reducer, "turnStarted");
    const notifications = [
      { method: "item/started", params: { item: { type: "agentMessage", id: "final", phase: "final_answer" } } },
      { method: "item/agentMessage/delta", params: { itemId: "final", delta: "Answer" } },
      { method: "item/completed", params: { item: { type: "agentMessage", id: "final", text: "Answer", phase: "final_answer" } } },
    ];
    const reductions = notifications.flatMap((notification) => mapper.mapNotification(notification)
      .map(({ event: mapped }) => reducer.reduce(boundByProvider(mapped))));
    const intents = reductions.flatMap((result) => result.kind === "reduced" ? result.writer : []);
    expect(intents).toContainEqual(expect.objectContaining({ kind: "assistant-body", content: "Answer" }));
    expect(intents.some((intent) => intent.kind === "terminal-projection")).toBe(false);
    const terminal = reducer.reduce(boundByProvider(mapper.mapNotification({ method: "turn/completed", params: { turn: { status: "completed" } } }).at(-1)?.event ?? event("turnComplete", { reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 })));
    expect(terminal.kind).toBe("reduced");
    if (terminal.kind !== "reduced") throw new Error(terminal.reason);
    expect(terminal.writer.some((intent) => intent.kind === "terminal-projection")).toBe(true);
  });

  it("carries parsed plan questions as data on the completing text event", () => {
    const reducer = new CodexLiveEventReducer(execution, "questions");
    const question = { id: "q1", category: "AUTH", question: "Which login?", options: [
      { id: "o1", title: "Passkey", description: "Use passkeys.", recommended: true },
      { id: "o2", title: "Password", description: "Use passwords." },
    ] };
    const block = `\`\`\`plan-questions\n${JSON.stringify([question])}\n\`\`\``;
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    const first = reducer.reduce(event("textDelta", { delta: block.slice(0, 20) }));
    expect(first.kind).toBe("reduced");
    if (first.kind !== "reduced") return;
    expect(first.writer).not.toContainEqual(expect.objectContaining({ kind: "plan-questions" }));
    const second = reducer.reduce(event("textDelta", { delta: block.slice(20) }));
    expect(second.kind).toBe("reduced");
    if (second.kind !== "reduced") return;
    expect(second.writer).toContainEqual({ kind: "plan-questions", questions: [question] });
    expect(second.publication.after).toBe("writer");
    expect(reducer.reduce(event("textDelta", { delta: block }))).toMatchObject({
      kind: "reduced", writer: expect.not.arrayContaining([{ kind: "plan-questions", questions: [question] }]),
    });
  });

  it("carries plan output data with the assistant body and bounds parser input", () => {
    const reducer = new CodexLiveEventReducer(execution, "output");
    const plan = "# Login plan\n\n## Implementation\n\nAdd passkey login.";
    const block = `\`\`\`\`mcode-plan\n${plan}\n\`\`\`\``;
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    expect(reducer.reduce(event("textDelta", { delta: block })).kind).toBe("reduced");
    const message = reducer.reduce(event("message", { content: "Provider prose", tokens: null }));
    expect(message.kind).toBe("reduced");
    if (message.kind !== "reduced") return;
    expect(message.writer).toContainEqual({ kind: "plan-captured", output: {
      title: "Login plan", contentMd: plan,
      captureSource: "fence",
    } });
    expect(message.writer[0]).toMatchObject({ kind: "assistant-body", content: "Provider prose" });

    const bounded = new CodexLiveEventReducer(execution, "questions");
    expect(bounded.reduce(event("turnStarted")).kind).toBe("reduced");
    expect(bounded.reduce(event("textDelta", { delta: "x".repeat(256 * 1024) })).kind).toBe("reduced");
    expect(bounded.reduce(event("textDelta", { delta: "x" }))).toEqual({
      kind: "unsupported", eventType: "textDelta", reason: "plan text exceeds the execution projection limit",
    });
  });

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
        reductions.push(reducer.reduce(boundByProvider(runtimeEvent.event)));
      }
    }

    expect(reductions.every((result) => result.kind === "reduced")).toBe(true);
    const reduced = reductions.filter((result) => result.kind === "reduced");
    expect(reduced.map((result) => result.publication.event.type)).toEqual([
      "turnStarted", "textDelta", "assistantMessageBoundary", "toolUse", "toolResult",
      "textDelta", "assistantMessageBoundary", "assistantMessageBoundary", "message", "turnComplete",
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

  it("rejects unbound session events and reduces explicitly bound notices and cursors", () => {
    const mapper = new CodexEventMapper(execution.threadId);
    const reducer = new CodexLiveEventReducer(execution);
    const session = reducer.reduce(mapper.sessionStartedEvent().event);
    expect(session).toEqual({
      kind: "unsupported", eventType: "system",
      reason: "event without execution identity needs the provider event routing owner",
    });
    const boundSession = reducer.reduce(event("system", { subtype: "provider.session.started" }));
    expect(boundSession).toMatchObject({ kind: "reduced", writer: [{ kind: "notice-session" }] });
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");

    const notice = mapper.mapNotification({ method: "unknown/new-method", params: {} })[0]?.event;
    expect(notice?.type).toBe("system");
    if (!notice) return;
    expect(reducer.reduce(notice)).toEqual({
      kind: "unsupported", eventType: "system",
      reason: "event without execution identity needs the provider event routing owner",
    });
    const reduced = reducer.reduce(boundByProvider(notice));
    expect(reduced.kind).toBe("reduced");
    if (reduced.kind !== "reduced") return;
    expect(reduced.writer.map(({ kind }) => kind)).toEqual(["system-notice"]);
    expect(reduced.publication.after).toBe("writer");
    expect(structuredClone(reduced)).toEqual(reduced);

    const cursor = reducer.reduce(event("system", { subtype: "sdk_session_id:native-1" }));
    expect(cursor.kind).toBe("reduced");
    if (cursor.kind !== "reduced") return;
    expect(cursor.writer.map(({ kind }) => kind)).toEqual(["session-cursor"]);
  });

  it("records mapped context outside compaction and leaves an unsupported terminal unchanged", () => {
    const mapper = new CodexEventMapper(execution.threadId, "native-main");
    const reducer = new CodexLiveEventReducer(execution);
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    mapper.prepareForTurn();
    mapper.mapNotification({ method: "turn/started", params: { threadId: "native-main", turn: { id: "native-turn" } } });
    const usage = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5 };
    const mapped = mapper.mapNotification({ method: "thread/tokenUsage/updated", params: {
      threadId: "native-main", turnId: "native-turn",
      tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
    } })[0]?.event;
    expect(mapped?.type).toBe("contextEstimate");
    if (!mapped) return;
    expect(reducer.reduce(mapped)).toEqual({
      kind: "unsupported", eventType: "contextEstimate",
      reason: "event without execution identity needs the provider event routing owner",
    });
    const first = reducer.reduce(boundByProvider(mapped));
    expect(first.kind).toBe("reduced");
    if (first.kind !== "reduced") return;
    expect(first.writer).toEqual([{ kind: "context-usage", tokensIn: 100, contextWindow: 200_000 }]);

    expect(reducer.reduce(event("compacting", { active: true }))).toMatchObject({
      kind: "reduced", writer: [{ kind: "compaction-started" }],
    });
    const during = reducer.reduce(boundByProvider(mapped));
    expect(during).toMatchObject({ kind: "reduced", writer: [] });
    const completion = event("turnComplete", { reason: "end_turn", costUsd: null, tokensIn: 100, tokensOut: 20 });
    expect(reducer.reduce(completion)).toEqual({
      kind: "unsupported", eventType: "turnComplete",
      reason: "turn completion during compaction needs the compaction terminal owner",
    });
    expect(reducer.reduce(event("compactSummary", { summary: "Shortened context" }))).toMatchObject({
      kind: "reduced", writer: [{ kind: "compaction-summary", summary: "Shortened context" }],
    });
    expect(reducer.reduce(event("compacting", { active: true }))).toMatchObject({
      kind: "reduced", writer: [{ kind: "compaction-started" }],
    });
    expect(reducer.reduce(event("compacting", { active: false }))).toMatchObject({
      kind: "reduced", writer: [{ kind: "compaction-divider" }],
    });
    expect(reducer.reduce(boundByProvider(mapped))).toMatchObject({
      kind: "reduced", writer: [{ kind: "context-usage", tokensIn: 100, contextWindow: 200_000 }],
    });
    expect(reducer.reduce(completion)).toMatchObject({
      kind: "reduced", writer: [{ kind: "context-usage", tokensIn: 100 }, { kind: "terminal-projection" }, { kind: "feature-event" }],
    });
  });

  it("publishes mapper retry and status events and projects a failed turn", () => {
    const mapper = new CodexEventMapper(execution.threadId, "native-main");
    const reducer = new CodexLiveEventReducer(execution);
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    mapper.prepareForTurn();
    mapper.mapNotification({ method: "turn/started", params: { threadId: "native-main", turn: { id: "native-turn" } } });
    const retry = mapper.mapNotification({ method: "error", params: {
      threadId: "native-main", error: { message: "temporary" }, willRetry: true,
    } })[0]?.event;
    expect(retry?.type).toBe("apiRetry");
    if (!retry) return;
    expect(reducer.reduce(boundByProvider(retry))).toMatchObject({ kind: "reduced", writer: [], publication: { after: "writer" } });
    const quota = AgentEventSchema().parse({ type: "quotaUpdate", threadId: execution.threadId, providerId: "codex", categories: [] });
    expect(reducer.reduce(quota)).toMatchObject({ kind: "unsupported", eventType: "quotaUpdate" });
    expect(reducer.reduce(boundByProvider(quota))).toMatchObject({ kind: "reduced", writer: [] });
    const status = mapper.mapNotification({ method: "mcpServer/startupStatus/updated", params: {
      threadId: "native-main", name: "search", status: "failed", error: "offline",
    } })[0]?.event;
    expect(status?.type).toBe("mcpServerStartupStatus");
    if (!status) return;
    expect(reducer.reduce(boundByProvider(status))).toMatchObject({ kind: "reduced", writer: [] });

    const failure = mapper.mapNotification({ method: "turn/completed", params: {
      threadId: "native-main", turn: { id: "native-turn", status: "failed", items: [], error: { message: "failed" } },
    } }).find(({ event: mapped }) => mapped.type === "error")?.event;
    expect(failure?.type).toBe("error");
    if (!failure) return;
    const terminal = reducer.reduce(boundByProvider(failure));
    expect(terminal).toMatchObject({
      kind: "reduced", writer: [{ kind: "turn-error", error: "failed" }, { kind: "terminal-projection", source: "error", outcome: "errored" }],
      publication: { after: "terminal" },
    });
    expect(structuredClone(terminal)).toEqual(terminal);
  });

  it("keeps post-turn goal and status publications while rejecting unowned goal receipts", () => {
    const mapper = new CodexEventMapper(execution.threadId, "native-main");
    const reducer = new CodexLiveEventReducer(execution);
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    expect(reducer.reduce(event("turnComplete", { reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 })).kind).toBe("reduced");
    const goalEvents = mapper.mapNotification({ method: "thread/goal/updated", params: {
      threadId: "native-main", turnId: "native-turn",
      goal: { threadId: "native-main", objective: "Ship", status: "complete", tokenBudget: null, tokensUsed: 5,
        timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 },
    } }).map(({ event: mapped }) => mapped);
    expect(goalEvents.map(({ type }) => type)).toEqual(["goalUpdated", "message", "goalCleared"]);
    const [goalUpdated, receipt, goalCleared] = goalEvents;
    if (!goalUpdated || !receipt || !goalCleared) return;
    expect(reducer.reduce(goalUpdated)).toMatchObject({ kind: "unsupported", eventType: "goalUpdated" });
    expect(reducer.reduce(boundByProvider(goalUpdated))).toMatchObject({ kind: "reduced", writer: [], publication: { after: "terminal" } });
    expect(reducer.reduce(boundByProvider(receipt))).toEqual({
      kind: "unsupported", eventType: "message", reason: "post-turn goal receipt needs the goal message owner",
    });
    expect(reducer.reduce(boundByProvider(goalCleared))).toMatchObject({ kind: "reduced", writer: [], publication: { after: "terminal" } });
    expect(reducer.reduce(event("ended", { turnExecutionId: execution.executionId }))).toMatchObject({ kind: "reduced" });
  });

  it("rejects another execution and unowned events without changing the active execution", () => {
    const reducer = new CodexLiveEventReducer(execution);
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    expect(reducer.reduce(event("textDelta", { delta: "wrong", turnExecutionId: "22222222-2222-4222-8222-222222222222" }))).toEqual({
      kind: "unsupported", eventType: "textDelta", reason: "different execution",
    });
    for (const status of [
      event("modelFallback", { requestedModel: "a", actualModel: "b" }),
      event("toolInputDelta", { partialJson: "{" }),
      event("toolProgress", { toolCallId: "tool-1", toolName: "command_execution", elapsedSeconds: 1 }),
      event("providerUnavailable", { providerId: "codex", reason: "disabled" }),
      event("hookProgress", { hookName: "check", output: "running" }),
    ]) {
      expect(reducer.reduce(status)).toMatchObject({
        kind: "reduced", writer: [], publication: { event: status, after: "writer" },
      });
    }
    const final = reducer.reduce(event("textDelta", { delta: "right", isFinalResponse: true }));
    expect(final.kind).toBe("reduced");
    if (final.kind !== "reduced") return;
    expect(final.writer).toContainEqual({ kind: "assistant-text-delta", delta: "right", classification: "final" });
  });
});
