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

  it("suppresses agent_thought_chunk so thinking data never leaks to the UI", () => {
    const state = createCursorAcpTurnState();
    const ev = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking out loud..." },
        },
      },
      threadId,
      state,
    );
    expect(ev).toEqual([]);
    expect(state.accumulator.assistantText).toBe("");
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

  it("maps plan session update to TodoWrite events", () => {
    const state = createCursorAcpTurnState();
    const events = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read the file", status: "completed", priority: "high" },
            { content: "Edit the function", status: "in_progress", priority: "medium" },
            { content: "Run tests", status: "pending", priority: "low" },
          ],
        },
      } as any,
      threadId,
      state,
    );
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      threadId,
      toolName: "TodoWrite",
    });
    const todos = (events[0] as any).toolInput.todos;
    expect(todos).toHaveLength(3);
    expect(todos[0]).toMatchObject({ content: "Read the file", status: "completed" });
    expect(todos[1]).toMatchObject({ content: "Edit the function", status: "in_progress" });
    expect(todos[2]).toMatchObject({ content: "Run tests", status: "pending" });
    expect(events[1]).toMatchObject({
      type: AgentEventType.ToolResult,
      threadId,
      isError: false,
    });
  });

  it("returns empty for plan with no entries", () => {
    const state = createCursorAcpTurnState();
    const events = mapCursorAcpSessionNotification(
      {
        sessionId: "s",
        update: { sessionUpdate: "plan", entries: [] },
      } as any,
      threadId,
      state,
    );
    expect(events).toEqual([]);
  });
});
