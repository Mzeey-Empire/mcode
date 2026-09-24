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
  return AgentEventSchema().parse({ type, threadId: execution.threadId, turnExecutionId: execution.executionId, ...fields });
}

function boundByProvider(mapped: AgentEvent): AgentEvent {
  return { ...mapped, turnExecutionId: execution.executionId };
}

describe("CodexLiveEventReducer", () => {
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
    const plan = { title: "Login plan", sections: [
      { id: "s1", title: "Implementation", level: 1, content: "Add passkey login." },
    ] };
    const block = `\`\`\`plan-output\n${JSON.stringify(plan)}\n\`\`\``;
    expect(reducer.reduce(event("turnStarted")).kind).toBe("reduced");
    expect(reducer.reduce(event("textDelta", { delta: block })).kind).toBe("reduced");
    const message = reducer.reduce(event("message", { content: "Provider prose", tokens: null }));
    expect(message.kind).toBe("reduced");
    if (message.kind !== "reduced") return;
    expect(message.writer).toContainEqual({ kind: "plan-output", output: {
      title: "Login plan", contentMd: "## Implementation\n\nAdd passkey login.",
      sectionsJson: '[{"id":"s1","title":"Implementation","level":1}]', changeSummary: null,
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
