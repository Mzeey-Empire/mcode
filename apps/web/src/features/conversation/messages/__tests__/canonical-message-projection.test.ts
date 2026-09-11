import { createAgentModelState, type AgentItem, type AgentTurn, type Message } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { projectCanonicalMessageList } from "../canonical-message-projection";
import { createTranscriptItemProjector } from "../virtual-items";

const THREAD_ID = "canonical-child";
const TURN_ID = "canonical-turn";
const STARTED_AT = "2026-08-18T12:00:00.000Z";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "child-prompt",
    thread_id: THREAD_ID,
    role: "user",
    content: "Inspect README.md",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: STARTED_AT,
    sequence: 0,
    attachments: null,
    ...overrides,
  };
}

function turn(
  status: AgentTurn["status"],
  endedAt: string | null = null,
  overrides: Partial<AgentTurn> = {},
): AgentTurn {
  return {
    id: TURN_ID,
    threadId: THREAD_ID,
    status,
    trigger: { kind: "child", sourceThreadId: "parent", sourceTurnId: "parent-turn" },
    permissionMode: "full",
    approvalReviewMode: "manual",
    approvalReviewReason: "manual-requested",
    providerIdentities: [],
    startedAt: STARTED_AT,
    endedAt,
    createdAt: STARTED_AT,
    updatedAt: endedAt ?? STARTED_AT,
    ...overrides,
  };
}

function item(
  id: string,
  kind: AgentItem["kind"],
  payload: Record<string, unknown>,
  createdAt: string,
  updatedAt = createdAt,
  turnId = TURN_ID,
): AgentItem {
  return {
    id,
    threadId: THREAD_ID,
    turnId,
    kind,
    providerIdentities: [],
    payload,
    createdAt,
    updatedAt,
  };
}

describe("projectCanonicalMessageList", () => {
  it("counts provider-neutral tools only within the displayed thread and turn", () => {
    const state = createAgentModelState();
    state.turns[TURN_ID] = turn("Completed", "2026-08-18T12:00:05.000Z");
    const answer = message({ id: "answer", role: "assistant", sequence: 1 });
    state.items.answer = item("answer", "message", { projection: "message", message: answer }, STARTED_AT);
    const record = (id: string, toolName = "Read", parent: string | null = null) => ({
      id, message_id: answer.id, parent_tool_call_id: parent, tool_name: toolName,
      input_summary: "{}", output_summary: "done", status: "completed",
      started_at: STARTED_AT, completed_at: STARTED_AT, sort_order: 0,
    });
    for (const id of ["read", "agent", "nested", "older", "other-thread"]) {
      state.items[id] = item(id, "tool-call", {
        projection: "toolCall",
        record: record(id, id === "agent" ? "Agent" : "Read", id === "nested" ? "agent" : null),
      }, STARTED_AT);
    }
    state.items.older!.turnId = "older-turn";
    state.items["other-thread"]!.threadId = "other-thread";
    const projection = projectCanonicalMessageList({
      threadId: THREAD_ID, state, messages: [answer], toolCalls: [], thoughtSegments: [],
    });
    expect(projection?.turnSummariesByMessageId.answer).toMatchObject({
      counts: { steps: 2, subagents: 1 }, durationMs: 5_000,
    });
  });

  it("projects active child reasoning and a completed tool into shared timeline inputs", () => {
    const state = createAgentModelState();
    state.turns[TURN_ID] = turn("Running");
    state.items.reasoning = item(
      "reasoning",
      "reasoning",
      { projection: "codexChildReasoning", content: "Reading the file" },
      "2026-08-18T12:00:01.000Z",
    );
    state.items.call = item(
      "call",
      "tool-call",
      {
        projection: "codexChildToolCall",
        nativeItemId: "native-read",
        toolName: "Read",
        toolInput: { path: "README.md" },
      },
      "2026-08-18T12:00:02.000Z",
    );
    state.items.result = item(
      "result",
      "tool-result",
      {
        projection: "codexChildToolResult",
        nativeItemId: "native-read",
        output: "contents",
        isError: false,
      },
      "2026-08-18T12:00:03.000Z",
    );

    const projection = projectCanonicalMessageList({
      threadId: THREAD_ID,
      state,
      messages: [message()],
      toolCalls: [],
      thoughtSegments: [],
    });

    expect(projection).toMatchObject({
      agentDisplayState: { phase: "streaming" },
      agentStartTime: Date.parse(STARTED_AT),
      thoughtSegments: [{ text: "Reading the file", isExplicitNonFinal: true }],
      toolCalls: [{
        id: "native-read",
        toolName: "Read",
        toolInput: { path: "README.md" },
        output: "contents",
        isError: false,
        isComplete: true,
      }],
    });
    expect(projection?.messages.map((entry) => entry.id)).toEqual(["child-prompt"]);
  });

  it("keeps completed child tools before the final answer and its footer", () => {
    const state = createAgentModelState();
    state.turns[TURN_ID] = turn("Completed", "2026-08-18T12:00:05.000Z", {
      permissionMode: "supervised",
      approvalReviewMode: "manual",
      approvalReviewReason: "provider-version-unsupported",
    });
    const prompt = message({ sequence: -1 });
    const opening = message({
      id: "child-open",
      role: "assistant",
      content: "ACTIVE_OPEN_A71C",
      sequence: 0,
      timestamp: "2026-08-18T12:00:01.000Z",
    });
    const answer = message({
      id: "child-answer",
      role: "assistant",
      content: "ACTIVE_STREAM_PROOF_A71C",
      sequence: 1,
      timestamp: "2026-08-18T12:00:04.000Z",
    });
    const protocolNotice = message({
      id: "protocol-notice",
      role: "system",
      content: "Codex sent an update this client does not recognize (thread/goal/cleared).",
      sequence: 2,
      timestamp: "2026-08-18T12:00:05.000Z",
    });
    state.items.opening = item(
      "opening",
      "message",
      { projection: "message", message: opening },
      opening.timestamp,
    );
    state.items.answer = item(
      "answer",
      "message",
      { projection: "message", message: answer },
      answer.timestamp,
    );
    state.items.reasoning = item(
      "reasoning",
      "reasoning",
      { projection: "codexChildReasoning", content: "Done" },
      "2026-08-18T12:00:02.000Z",
    );
    state.items.call = item(
      "call",
      "tool-call",
      {
        projection: "codexChildToolCall",
        nativeItemId: "native-read",
        toolName: "Read",
        toolInput: { path: "README.md" },
      },
      "2026-08-18T12:00:03.000Z",
    );
    state.items.result = item(
      "result",
      "tool-result",
      {
        projection: "codexChildToolResult",
        nativeItemId: "native-read",
        output: "contents",
        isError: false,
      },
      "2026-08-18T12:00:03.500Z",
    );

    const projection = projectCanonicalMessageList({
      threadId: THREAD_ID,
      state,
      messages: [prompt, opening, answer, protocolNotice],
      toolCalls: [],
      thoughtSegments: [],
    });

    expect(projection?.agentDisplayState).toEqual({ phase: "completed" });
    expect(projection?.messages.map((entry) => entry.id)).toEqual([
      "child-prompt",
      "child-open",
      "child-answer",
      "protocol-notice",
    ]);
    expect(projection?.thoughtSegments).toEqual([expect.objectContaining({ text: "Done" })]);
    expect(projection?.currentTurnMessageId).toBe("child-answer");
    expect(projection?.assistantResponseKeys).toEqual({
      "child-answer": `canonical-turn-response:${TURN_ID}`,
    });
    expect(projection?.turnSummariesByMessageId).toEqual({
      "child-answer": {
        counts: { steps: 1, thoughts: 1, subagents: 0 },
        durationMs: 5_000,
        approvalReview: { mode: "manual", reason: "provider-version-unsupported" },
      },
    });
    const timeline = createTranscriptItemProjector()({
      messages: projection!.messages,
      agentDisplayState: projection!.agentDisplayState,
      agentStartTime: projection!.agentStartTime,
      streamingText: projection!.streamingText,
      toolCalls: projection!.toolCalls,
      thoughtSegments: projection!.thoughtSegments,
      currentTurn: {
        threadId: THREAD_ID,
        messageId: projection!.currentTurnMessageId,
        responseKey: projection!.currentTurnResponseKey,
        responseKeysByMessageId: projection!.assistantResponseKeys,
      },
      turnSummariesByMessageId: projection!.turnSummariesByMessageId,
    });
    expect(timeline.map((row) => {
      if (row.type === "message") return `message:${row.message.id}`;
      if (row.type === "narrative-flow") return `tools:${row.toolCalls.map((call) => call.id).join(",")}`;
      if (row.type === "persisted-turn-footer") return `footer:${row.messageId}`;
      return row.type;
    })).toEqual([
      "message:child-prompt",
      "message:child-open",
      "tools:native-read",
      "message:child-answer",
      "narrative-indicator",
      "footer:child-answer",
      "message:protocol-notice",
    ]);
  });

  it("does not project an approval-review lifecycle for Full Access", () => {
    const state = createAgentModelState();
    state.turns[TURN_ID] = turn("Completed", "2026-08-18T12:00:05.000Z", {
      permissionMode: "full",
      approvalReviewMode: "manual",
      approvalReviewReason: "full-access-bypasses-approval-review",
    });
    const answer = message({ id: "child-answer", role: "assistant", content: "ok", sequence: 1, timestamp: "2026-08-18T12:00:04.000Z" });
    state.items.answer = item("answer", "message", { projection: "message", message: answer }, answer.timestamp);

    const projection = projectCanonicalMessageList({
      threadId: THREAD_ID,
      state,
      messages: [message(), answer],
      toolCalls: [],
      thoughtSegments: [],
    });

    expect(projection?.turnSummariesByMessageId["child-answer"]?.approvalReview).toBeUndefined();
  });

  it("projects an active child answer as live assistant text without summarizing its turn", () => {
    const state = createAgentModelState();
    state.turns[TURN_ID] = turn("Running");
    const answer = message({
      id: "child-answer",
      role: "assistant",
      content: "Still working",
      sequence: 1,
      timestamp: "2026-08-18T12:00:04.000Z",
    });
    state.items.answer = item(
      "answer",
      "message",
      { projection: "message", message: answer },
      answer.timestamp,
    );

    const projection = projectCanonicalMessageList({
      threadId: THREAD_ID,
      state,
      messages: [message()],
      toolCalls: [],
      thoughtSegments: [],
    });

    expect(projection).toMatchObject({
      messages: [expect.objectContaining({ id: "child-prompt" })],
      streamingText: "Still working",
      agentDisplayState: { phase: "streaming" },
    });
    const timeline = createTranscriptItemProjector()({
      messages: projection!.messages,
      agentDisplayState: projection!.agentDisplayState,
      agentStartTime: projection!.agentStartTime,
      streamingText: projection!.streamingText,
      toolCalls: projection!.toolCalls,
      thoughtSegments: projection!.thoughtSegments,
      currentTurn: {
        threadId: THREAD_ID,
        messageId: projection!.currentTurnMessageId,
        responseKey: projection!.currentTurnResponseKey,
        responseKeysByMessageId: projection!.assistantResponseKeys,
      },
      turnSummariesByMessageId: projection!.turnSummariesByMessageId,
    });
    expect(timeline.filter((row) => row.type === "message").map((row) => row.message.content))
      .toEqual(["Inspect README.md", "Still working"]);
    expect(projection?.turnSummariesByMessageId).toEqual({});
  });

  it("summarizes structured activity for every completed child turn", () => {
    const state = createAgentModelState();
    const secondTurnId = "canonical-turn-2";
    state.turns[TURN_ID] = turn("Completed", "2026-08-18T12:00:05.000Z", { permissionMode: "supervised" });
    state.turns[secondTurnId] = turn("Completed", "2026-08-18T12:01:05.000Z", {
      id: secondTurnId,
      permissionMode: "supervised",
      startedAt: "2026-08-18T12:01:00.000Z",
      createdAt: "2026-08-18T12:01:00.000Z",
      updatedAt: "2026-08-18T12:01:05.000Z",
    });
    const firstAnswer = message({
      id: "child-answer-1",
      role: "assistant",
      content: "First answer",
      sequence: 1,
      timestamp: "2026-08-18T12:00:04.000Z",
    });
    const secondPrompt = message({
      id: "child-prompt-2",
      content: "Follow up",
      sequence: 2,
      timestamp: "2026-08-18T12:01:00.000Z",
    });
    const secondAnswer = message({
      id: "child-answer-2",
      role: "assistant",
      content: "Second answer",
      sequence: 3,
      timestamp: "2026-08-18T12:01:04.000Z",
    });
    state.items.firstCall = item(
      "first-call",
      "tool-call",
      { projection: "codexChildToolCall", nativeItemId: "read-1", toolName: "Read" },
      "2026-08-18T12:00:01.000Z",
    );
    state.items.firstResult = item(
      "first-result",
      "tool-result",
      { projection: "codexChildToolResult", nativeItemId: "read-1", output: "ok" },
      "2026-08-18T12:00:02.000Z",
      "2026-08-18T12:00:03.000Z",
    );
    state.items.firstAnswer = item(
      "first-answer",
      "message",
      { projection: "message", message: firstAnswer },
      firstAnswer.timestamp,
    );
    state.items.secondCall = item(
      "second-call",
      "tool-call",
      { projection: "codexChildToolCall", nativeItemId: "read-2", toolName: "Read" },
      "2026-08-18T12:01:01.000Z",
      "2026-08-18T12:01:01.000Z",
      secondTurnId,
    );
    state.items.secondResult = item(
      "second-result",
      "tool-result",
      { projection: "codexChildToolResult", nativeItemId: "read-2", output: "ok" },
      "2026-08-18T12:01:02.000Z",
      "2026-08-18T12:01:03.000Z",
      secondTurnId,
    );
    state.items.secondAnswer = item(
      "second-answer",
      "message",
      { projection: "message", message: secondAnswer },
      secondAnswer.timestamp,
      secondAnswer.timestamp,
      secondTurnId,
    );

    const projection = projectCanonicalMessageList({
      threadId: THREAD_ID,
      state,
      messages: [message(), firstAnswer, secondPrompt, secondAnswer],
      toolCalls: [],
      thoughtSegments: [],
    });

    expect(projection?.messages.map((entry) => entry.id)).toEqual([
      "child-prompt",
      "child-answer-1",
      "child-prompt-2",
      "child-answer-2",
    ]);
    expect(projection?.turnSummariesByMessageId).toEqual({
      "child-answer-1": {
        counts: { steps: 1, thoughts: 0, subagents: 0 },
        durationMs: 5_000,
        approvalReview: { mode: "manual", reason: "manual-requested" },
      },
      "child-answer-2": {
        counts: { steps: 1, thoughts: 0, subagents: 0 },
        durationMs: 5_000,
        approvalReview: { mode: "manual", reason: "manual-requested" },
      },
    });
  });
});
