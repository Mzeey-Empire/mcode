import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { capturePlanFromAgentText } from "../../../conformance/harness.js";
import {
  createDevinAcpTurnState,
  devinPermissionPreview,
  mapDevinAcpSessionNotification,
  observeDevinExtensionNotification,
} from "../devin-acp-event-mapper.js";

const THREAD = "thread-1";

function notification(update: Record<string, unknown>): SessionNotification {
  return { sessionId: "acp-1", update } as unknown as SessionNotification;
}

function toolCall(toolCallId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Tool call",
    kind: "other",
    rawInput: { path: "file.ts" },
    ...extra,
  };
}

describe("mapDevinAcpSessionNotification", () => {
  it("maps the captured ACP task plan to a paired TodoWrite snapshot without changing turn state", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(notification({
      sessionUpdate: "plan",
      entries: [
        { content: "create a.txt", priority: "medium", status: "completed" },
        { content: "create b.txt", priority: "medium", status: "in_progress" },
        { content: "create c.txt", priority: "medium", status: "pending" },
      ],
    }), THREAD, state);
    expect(events).toEqual([
      {
        type: "toolUse", threadId: THREAD, toolCallId: expect.any(String), toolName: "TodoWrite",
        toolInput: { todos: [
          { id: "0", content: "create a.txt", status: "completed", priority: "medium" },
          { id: "1", content: "create b.txt", status: "in_progress", priority: "medium" },
          { id: "2", content: "create c.txt", status: "pending", priority: "medium" },
        ] },
      },
      {
        type: "toolResult", threadId: THREAD, toolCallId: expect.any(String),
        output: "Updated 3 todo(s)", isError: false,
      },
    ]);
    const [use, result] = events;
    if (use.type !== "toolUse" || result.type !== "toolResult") throw new Error("Expected tool pair");
    expect(result.toolCallId).toBe(use.toolCallId);
    expect(state).toEqual(createDevinAcpTurnState());
  });

  it("ignores empty ACP task plans", () => {
    expect(mapDevinAcpSessionNotification(
      notification({ sessionUpdate: "plan", entries: [] }), THREAD, createDevinAcpTurnState(),
    )).toEqual([]);
  });

  it("preserves the plan fence through the mapper and captures it exactly once", () => {
    const state = createDevinAcpTurnState();
    const deltas: string[] = [];
    for (const text of ["Summary\n``", "``mcode-", "plan\n# Devin plan\n## Build\nDo it.\n```", "`"]) {
      const events = mapDevinAcpSessionNotification({
        sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      }, THREAD, state);
      for (const event of events) if (event.type === "textDelta") deltas.push(event.delta);
    }
    expect(capturePlanFromAgentText(deltas, THREAD)).toEqual([{
      threadId: THREAD, source: "fence", markdown: "# Devin plan\n## Build\nDo it.",
    }]);
  });
  it("emits text deltas and accumulates assistant text", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
      THREAD,
      state,
    );
    expect(events).toEqual([{ type: "textDelta", threadId: THREAD, delta: "hello" }]);
    expect(state.accumulator.assistantText).toBe("hello");
    expect(state.accumulator.assistantFinalText).toBe("");
  });

  it("emits thought chunks as reasoning deltas without polluting the assistant text", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      }),
      THREAD,
      state,
    );
    expect(events).toEqual([
      { type: "reasoningDelta", threadId: THREAD, delta: "thinking" },
    ]);
    expect(state.accumulator.assistantText).toBe("");
  });

  it("marks message text as the final response only after a tool has fired", () => {
    const state = createDevinAcpTurnState();
    const early = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "intro " },
      }),
      THREAD,
      state,
    );
    expect(early[0]).not.toHaveProperty("isFinalResponse");

    const tool = mapDevinAcpSessionNotification(notification(toolCall("tc-1")), THREAD, state);
    expect(tool[0]).toEqual({ type: "assistantMessageBoundary", threadId: THREAD, isFinalResponse: false });
    expect(tool[1]).toMatchObject({ type: "toolUse", toolCallId: "tc-1" });
    mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        rawOutput: "done",
      }),
      THREAD,
      state,
    );
    const late = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "summary" },
      }),
      THREAD,
      state,
    );
    expect(late[0]).toMatchObject({ type: "textDelta", delta: "summary", isFinalResponse: true });
    expect(state.accumulator.assistantFinalText).toBe("summary");
  });

  it("maps inference tool names over ACP kind (write_plan -> Write)", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(
      notification(
        toolCall("tc-plan", {
          kind: "edit",
          _meta: { "cognition.ai/inferenceToolName": "write_plan" },
        }),
      ),
      THREAD,
      state,
    );
    expect(events).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "tc-plan",
        toolName: "Write",
        toolInput: { path: "file.ts" },
      },
    ]);
  });

  it("maps run_subagent tool calls to Agent", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(
      notification(
        toolCall("tc-agent", {
          kind: "other",
          _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
        }),
      ),
      THREAD,
      state,
    );
    expect(events[0]).toMatchObject({ toolName: "Agent" });
    expect(state.pendingSubagentCallIds).toEqual(["tc-agent"]);
  });

  it("emits ToolUse at a marker-only tool call and merges late rawInput on update", () => {
    const state = createDevinAcpTurnState();
    const started = mapDevinAcpSessionNotification(
      notification({ sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Read", kind: "read" }),
      THREAD,
      state,
    );
    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "tc-2",
        toolName: "Read",
        toolInput: {},
      },
    ]);

    const events = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-2",
        status: "completed",
        rawInput: { path: "a.ts" },
        rawOutput: "file contents",
      }),
      THREAD,
      state,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "tc-2",
      toolName: "Read",
      toolInput: { path: "a.ts" },
    });
    expect(events[1]).toMatchObject({
      type: "toolResult",
      toolCallId: "tc-2",
      output: "file contents",
      isError: false,
    });
  });

  it("keeps tool calls at their invocation position ahead of later text", () => {
    const state = createDevinAcpTurnState();
    const published: string[] = [];
    const collect = (update: Record<string, unknown>) => {
      for (const event of mapDevinAcpSessionNotification(notification(update), THREAD, state)) {
        published.push(event.type);
      }
    };
    collect({ sessionUpdate: "tool_call", toolCallId: "tc-a", title: "Read", kind: "read" });
    collect({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Reading now." },
    });
    collect({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-a",
      status: "completed",
      rawOutput: "done",
    });
    expect(published).toEqual(["toolUse", "textDelta", "toolResult"]);
  });

  it("emits ToolUse + ToolResult for orphan terminal updates", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-orphan",
        status: "completed",
        title: "Bash",
        kind: "execute",
        rawInput: { cmd: "ls" },
        rawOutput: "ok",
      }),
      THREAD,
      state,
    );
    expect(events.map((e) => e.type)).toEqual(["toolUse", "toolResult"]);
    expect(events[0]).toMatchObject({ toolName: "Bash", toolInput: { cmd: "ls" } });
  });

  it("flags failed results and surfaces the terminal exit code", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(
      notification(toolCall("tc-3", { kind: "execute" })),
      THREAD,
      state,
    );
    const events = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-3",
        status: "failed",
        rawOutput: "boom",
        _meta: { terminal_exit: { exit_code: 17 } },
      }),
      THREAD,
      state,
    );
    expect(events[0]).toMatchObject({
      type: "toolResult",
      output: "boom",
      isError: true,
      exitCode: 17,
    });
  });

  it("enriches and closes the run_subagent call instead of emitting a second Agent call", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(
      notification(
        toolCall("tc-parent", {
          kind: "other",
          _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
        }),
      ),
      THREAD,
      state,
    );

    const started = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        _meta: {
          "cognition.ai/subagent_started": {
            task: "survey",
            title: "Survey repo",
            profile: "scout",
          },
        },
      }),
      THREAD,
      state,
    );
    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "tc-parent",
        toolName: "Agent",
        toolInput: {
          task: "survey",
          title: "Survey repo",
          profile: "scout",
          description: "survey",
          subagentType: "scout",
          is_background: false,
          agentId: "agent-1",
        },
      },
    ]);
    expect(state.accumulator.pendingToolCalls.has("tc-parent")).toBe(true);

    const completed = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        _meta: {
          "cognition.ai/subagent_completed": { summary: "done", success: true },
        },
      }),
      THREAD,
      state,
    );
    expect(completed).toEqual([
      {
        type: "toolResult",
        threadId: THREAD,
        toolCallId: "tc-parent",
        output: "done",
        isError: false,
      },
    ]);
    expect(state.pendingSubagentCallIds).toEqual([]);
    expect(state.accumulator.pendingToolCalls.size).toBe(0);

    const markerResult = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-parent",
        status: "completed",
        rawOutput: "Subagent completed",
      }),
      THREAD,
      state,
    );
    expect(markerResult).toEqual([]);
  });

  it("keeps a background subagent running when run_subagent returns first", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(
      notification(
        toolCall("tc-bg", {
          kind: "other",
          _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
        }),
      ),
      THREAD,
      state,
    );
    mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-bg",
        _meta: { "cognition.ai/subagent_started": { task: "watch", isBackground: true } },
      }),
      THREAD,
      state,
    );
    const markerResult = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-bg",
        status: "completed",
        rawOutput: "Started background subagent",
      }),
      THREAD,
      state,
    );
    expect(markerResult).toEqual([]);
    expect(state.accumulator.pendingToolCalls.has("tc-bg")).toBe(true);

    const completed = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-bg",
        _meta: { "cognition.ai/subagent_completed": { summary: "watched", success: true } },
      }),
      THREAD,
      state,
    );
    expect(completed).toEqual([
      { type: "toolResult", threadId: THREAD, toolCallId: "tc-bg", output: "watched", isError: false },
    ]);
  });

  it("pairs parallel subagents with their run_subagent calls in spawn order", () => {
    const state = createDevinAcpTurnState();
    const runSubagent = (toolCallId: string) =>
      notification(
        toolCall(toolCallId, {
          kind: "other",
          _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
        }),
      );
    const subagentStarted = (agentId: string, task: string) =>
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: agentId,
        status: "in_progress",
        _meta: { "cognition.ai/subagent_started": { task } },
      });
    const childOf = (toolCallId: string, agentId: string) =>
      notification(
        toolCall(toolCallId, {
          kind: "read",
          _meta: {
            "cognition.ai/inferenceToolName": "read",
            "cognition.ai/subagent_context": { parentAgentId: agentId },
          },
        }),
      );
    const subagentCompleted = (agentId: string, summary: string) =>
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: agentId,
        _meta: { "cognition.ai/subagent_completed": { summary, success: true } },
      });

    mapDevinAcpSessionNotification(runSubagent("call-a"), THREAD, state);
    mapDevinAcpSessionNotification(runSubagent("call-b"), THREAD, state);
    const first = mapDevinAcpSessionNotification(subagentStarted("agent-1", "alpha"), THREAD, state);
    const second = mapDevinAcpSessionNotification(subagentStarted("agent-2", "beta"), THREAD, state);
    const childOfSecond = mapDevinAcpSessionNotification(childOf("read-b", "agent-2"), THREAD, state);
    const secondDone = mapDevinAcpSessionNotification(subagentCompleted("agent-2", "beta done"), THREAD, state);
    const firstDone = mapDevinAcpSessionNotification(subagentCompleted("agent-1", "alpha done"), THREAD, state);

    expect(first).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "call-a",
        toolName: "Agent",
        toolInput: { task: "alpha", description: "alpha", is_background: false, agentId: "agent-1" },
      },
    ]);
    expect(second).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "call-b",
        toolName: "Agent",
        toolInput: { task: "beta", description: "beta", is_background: false, agentId: "agent-2" },
      },
    ]);
    expect(childOfSecond).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "read-b",
        toolName: "Read",
        toolInput: { path: "file.ts" },
        parentToolCallId: "call-b",
      },
    ]);
    expect(secondDone).toEqual([
      { type: "toolResult", threadId: THREAD, toolCallId: "read-b", output: "", isError: false },
      { type: "toolResult", threadId: THREAD, toolCallId: "call-b", output: "beta done", isError: false },
    ]);
    expect(firstDone).toEqual([
      { type: "toolResult", threadId: THREAD, toolCallId: "call-a", output: "alpha done", isError: false },
    ]);
  });

  it("uses the agentId as the call when no run_subagent marker is pending", () => {
    const state = createDevinAcpTurnState();
    const started = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-solo",
        _meta: { "cognition.ai/subagent_started": { task: "solo", profile: "subagent_explore" } },
      }),
      THREAD,
      state,
    );
    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "agent-solo",
        toolName: "Agent",
        toolInput: {
          task: "solo",
          profile: "subagent_explore",
          description: "solo",
          subagentType: "subagent_explore",
          is_background: false,
          agentId: "agent-solo",
        },
      },
    ]);
    expect(state.accumulator.pendingToolCalls.has("agent-solo")).toBe(true);
  });

  it("copies task to description on run_subagent markers so narrative extractors find it", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(
      notification(
        toolCall("tc-parent", {
          kind: "other",
          rawInput: { task: "Survey fixture files" },
          _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
        }),
      ),
      THREAD,
      state,
    );
    expect(events[0]).toMatchObject({
      toolName: "Agent",
      toolInput: { task: "Survey fixture files", description: "Survey fixture files" },
    });
  });

  it("closes the run_subagent call when subagent_completed beats subagent_started", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(
      notification(
        toolCall("tc-parent", {
          kind: "other",
          _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
        }),
      ),
      THREAD,
      state,
    );
    const completed = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        _meta: { "cognition.ai/subagent_completed": { summary: "done", success: true } },
      }),
      THREAD,
      state,
    );
    expect(completed).toEqual([]);
    const started = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        _meta: { "cognition.ai/subagent_started": { task: "survey" } },
      }),
      THREAD,
      state,
    );
    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "tc-parent",
        toolName: "Agent",
        toolInput: { task: "survey", description: "survey", is_background: false, agentId: "agent-1" },
      },
      { type: "toolResult", threadId: THREAD, toolCallId: "tc-parent", output: "done", isError: false },
    ]);
    expect(state.accumulator.pendingToolCalls.size).toBe(0);

    const markerResult = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-parent",
        status: "completed",
        rawOutput: "done",
      }),
      THREAD,
      state,
    );
    expect(markerResult).toEqual([]);
    const late = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "final answer" },
      }),
      THREAD,
      state,
    );
    expect(late[0]).toMatchObject({ isFinalResponse: true });
  });

  it("nests subagent_context child calls under the run_subagent call without blocking the final response", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(
      notification(
        toolCall("tc-parent", {
          kind: "other",
          _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
        }),
      ),
      THREAD,
      state,
    );
    mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        _meta: { "cognition.ai/subagent_started": { task: "survey" } },
      }),
      THREAD,
      state,
    );

    const child = mapDevinAcpSessionNotification(
      notification(
        toolCall("read_0#abc", {
          kind: "read",
          _meta: {
            "cognition.ai/inferenceToolName": "read",
            "cognition.ai/subagent_context": { parentAgentId: "agent-1" },
          },
        }),
      ),
      THREAD,
      state,
    );
    expect(child).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "read_0#abc",
        toolName: "Read",
        toolInput: { path: "file.ts" },
        parentToolCallId: "tc-parent",
      },
    ]);
    // Child markers never receive a terminal update; they must not count as pending.
    expect(state.accumulator.pendingToolCalls.has("read_0#abc")).toBe(false);
    expect(state.subagentChildAgentByCallId.get("read_0#abc")).toBe("agent-1");

    const completed = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        _meta: { "cognition.ai/subagent_completed": { summary: "done", success: true } },
      }),
      THREAD,
      state,
    );
    expect(completed).toEqual([
      { type: "toolResult", threadId: THREAD, toolCallId: "read_0#abc", output: "", isError: false },
      { type: "toolResult", threadId: THREAD, toolCallId: "tc-parent", output: "done", isError: false },
    ]);
    expect(state.subagentChildAgentByCallId.size).toBe(0);

    mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-parent",
        status: "completed",
        rawOutput: "Subagent completed",
      }),
      THREAD,
      state,
    );
    const late = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "final answer" },
      }),
      THREAD,
      state,
    );
    expect(late[0]).toMatchObject({ isFinalResponse: true });
    expect(state.accumulator.assistantFinalText).toBe("final answer");
  });

  it("marks flushed child results as errors when the subagent fails", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(
      notification(
        toolCall("child-1", {
          kind: "read",
          _meta: { "cognition.ai/subagent_context": { parentAgentId: "agent-9" } },
        }),
      ),
      THREAD,
      state,
    );
    const completed = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-9",
        _meta: { "cognition.ai/subagent_completed": { summary: "boom", success: false } },
      }),
      THREAD,
      state,
    );
    // agent-9 never started, so it has no call to close yet.
    expect(completed).toEqual([
      { type: "toolResult", threadId: THREAD, toolCallId: "child-1", output: "", isError: true },
    ]);
  });

  it("keeps the parent link when a marker-only child gets its input later", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(
      notification(
        toolCall("child-2", {
          rawInput: {},
          _meta: { "cognition.ai/subagent_context": { parentAgentId: "agent-1" } },
        }),
      ),
      THREAD,
      state,
    );
    const merge = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "child-2",
        status: "in_progress",
        rawInput: { path: "late.ts" },
      }),
      THREAD,
      state,
    );
    expect(merge).toEqual([
      {
        type: "toolUse",
        threadId: THREAD,
        toolCallId: "child-2",
        toolName: "Tool",
        toolInput: { path: "late.ts" },
        parentToolCallId: "agent-1",
      },
    ]);
  });

  it("resolves a child marker that arrives after its subagent completed", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        _meta: { "cognition.ai/subagent_completed": { summary: "done", success: false } },
      }),
      THREAD,
      state,
    );
    const late = mapDevinAcpSessionNotification(
      notification(
        toolCall("child-3", {
          _meta: { "cognition.ai/subagent_context": { parentAgentId: "agent-1" } },
        }),
      ),
      THREAD,
      state,
    );
    expect(late.map((e) => e.type)).toEqual(["toolUse", "toolResult"]);
    expect(late[1]).toMatchObject({ toolCallId: "child-3", isError: true });
    expect(state.subagentChildAgentByCallId.size).toBe(0);
    expect(state.accumulator.pendingToolCalls.has("child-3")).toBe(false);
  });

  it("treats a root-level subagent_context as top-level", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(
      notification(
        toolCall("root-1", {
          _meta: { "cognition.ai/subagent_context": { parentAgentId: "root" } },
        }),
      ),
      THREAD,
      state,
    );
    expect(events[0]).toMatchObject({ toolCallId: "root-1" });
    expect(events[0]).not.toHaveProperty("parentToolCallId");
    expect(state.accumulator.pendingToolCalls.has("root-1")).toBe(true);
  });

  it("maps usage_update into a ContextEstimate", () => {
    const state = createDevinAcpTurnState();
    const events = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "usage_update",
        used: 1234,
        size: 200_000,
        _meta: {
          "cognition.ai/outputTokens": 42,
          "cognition.ai/cachedReadTokens": 7,
        },
      }),
      THREAD,
      state,
    );
    expect(events).toEqual([
      {
        type: "contextEstimate",
        threadId: THREAD,
        tokensIn: 1234,
        contextWindow: 200_000,
        tokensOut: 42,
        cacheReadTokens: 7,
      },
    ]);
  });

  it("ignores non-renderable session updates", () => {
    const state = createDevinAcpTurnState();
    for (const kind of [
      "user_message_chunk",
      "available_commands_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
    ]) {
      expect(
        mapDevinAcpSessionNotification(notification({ sessionUpdate: kind }), THREAD, state),
      ).toEqual([]);
    }
  });

  it("bounds retained tool output", () => {
    const state = createDevinAcpTurnState();
    mapDevinAcpSessionNotification(notification(toolCall("tc-big")), THREAD, state);
    const big = "x".repeat(70_000);
    const events = mapDevinAcpSessionNotification(
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-big",
        status: "completed",
        rawOutput: big,
      }),
      THREAD,
      state,
    );
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "toolResult", isError: false });
    expect((result as { output: string }).output.length).toBeLessThan(big.length);
    expect((result as { output: string }).output).toContain("[Devin tool output truncated]");
  });
});

describe("observeDevinExtensionNotification", () => {
  it("captures the agent_stopped model label", () => {
    const state = createDevinAcpTurnState();
    observeDevinExtensionNotification("_cognition.ai/agent_stopped", {
      stats: { modelLabel: "swe-2" },
    }, state);
    expect(state.stoppedModelLabel).toBe("swe-2");
  });

  it("ignores other methods and null state", () => {
    const state = createDevinAcpTurnState();
    observeDevinExtensionNotification("_cognition.ai/other", {}, state);
    observeDevinExtensionNotification("_cognition.ai/agent_stopped", { stats: {} }, null);
    expect(state.stoppedModelLabel).toBeNull();
  });
});

describe("devinPermissionPreview", () => {
  it("prefers the editable command meta", () => {
    expect(
      devinPermissionPreview({
        _meta: { "cognition.ai/editableCommand": "rm -rf build" },
      }),
    ).toBe("rm -rf build");
    expect(devinPermissionPreview({})).toBeUndefined();
  });
});
