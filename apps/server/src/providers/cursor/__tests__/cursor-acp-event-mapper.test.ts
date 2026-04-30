import { describe, expect, it } from "vitest";
import { AgentEventType } from "@mcode/contracts";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
} from "../cursor-acp-event-mapper.js";

describe("mapCursorAcpSessionNotification", () => {
  const threadId = "t1";

  it("maps agent text chunks to TextDelta and accumulates assistant text", () => {
    const state = createCursorAcpTurnState();
    const ev1 = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hi" },
        },
      },
      threadId,
      state,
    );
    expect(ev1).toEqual([
      { type: AgentEventType.TextDelta, threadId, delta: "Hi" },
    ]);
    const ev2 = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: " there" },
        },
      },
      threadId,
      state,
    );
    expect(ev2[0]).toMatchObject({ delta: " there" });
    expect(state.accumulator.assistantText).toBe("Hi there");
  });

  it("maps tool_call_update to ToolResult", () => {
    const state = createCursorAcpTurnState();
    mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Shell",
          rawInput: { shellToolCall: { args: { command: "ls" } } },
          status: "in_progress",
        },
      },
      threadId,
      state,
    );
    const done = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          rawInput: {
            shellToolCall: {
              args: { command: "ls" },
              result: { success: "ok" },
            },
          },
        },
      },
      threadId,
      state,
    );
    expect(done.some((e) => e.type === AgentEventType.ToolResult && e.toolCallId === "c1")).toBe(
      true,
    );
  });
});
