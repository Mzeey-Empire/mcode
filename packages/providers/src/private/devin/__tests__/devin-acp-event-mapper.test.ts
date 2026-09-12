import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
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

  it("emits thought deltas without polluting the assistant text", () => {
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
      { type: "textDelta", threadId: THREAD, delta: "thinking", isFinalResponse: false },
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

    mapDevinAcpSessionNotification(notification(toolCall("tc-1")), THREAD, state);
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

  it("tracks subagent_started/completed updates keyed by agentId", () => {
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
        toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: { task: "survey", title: "Survey repo", profile: "scout", is_background: false },
        parentToolCallId: "tc-parent",
      },
    ]);

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
        toolCallId: "agent-1",
        output: "done",
        isError: false,
      },
    ]);
    expect(state.pendingSubagentCallIds).toEqual([]);
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
