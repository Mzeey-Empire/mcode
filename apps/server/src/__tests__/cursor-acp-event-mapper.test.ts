import { describe, it, expect } from "vitest";
import {
  mapCursorAcpNotification,
  type CursorStreamAccumulator,
} from "../providers/cursor/cursor-acp-event-mapper.js";

function freshAcc(): CursorStreamAccumulator {
  return { assistantText: "", toolStartTimes: new Map() };
}

describe("mapCursorAcpNotification", () => {
  it("emits TextDelta for agent_message_chunk", () => {
    const acc = freshAcc();
    const events = mapCursorAcpNotification(
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "hello" },
          },
        },
      },
      "t1",
      acc,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "textDelta", delta: "hello" });
    expect(acc.assistantText).toBe("hello");
  });

  it("returns empty for non-session/update methods", () => {
    const events = mapCursorAcpNotification(
      { method: "other/thing", params: {} },
      "t1",
      freshAcc(),
    );
    expect(events).toEqual([]);
  });

  it("returns empty for unknown sessionUpdate types (no crash)", () => {
    const events = mapCursorAcpNotification(
      {
        method: "session/update",
        params: { update: { sessionUpdate: "some_unknown_type" } },
      },
      "t1",
      freshAcc(),
    );
    expect(events).toEqual([]);
  });

  describe("cursor/update_todos", () => {
    it("emits ToolUse with TodoWrite toolName for cursor/update_todos", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "cursor/update_todos",
          params: {
            todos: [
              { id: "1", content: "Fix the bug", status: "in_progress" },
              { id: "2", content: "Write tests", status: "pending" },
            ],
          },
        },
        "t1",
        acc,
      );

      // Should emit a single ToolUse event that looks like a TodoWrite call
      // so the existing threadStore TodoWrite interception picks it up.
      expect(events).toHaveLength(2);

      const toolUse = events[0];
      expect(toolUse).toMatchObject({
        type: "toolUse",
        threadId: "t1",
        toolName: "TodoWrite",
      });
      // toolInput should contain the todos array
      const input = (toolUse as { toolInput: Record<string, unknown> }).toolInput;
      expect(input.todos).toHaveLength(2);

      const toolResult = events[1];
      expect(toolResult).toMatchObject({
        type: "toolResult",
        threadId: "t1",
        isError: false,
      });
    });
  });

  describe("cursor/task notification", () => {
    it("emits System event for cursor/task", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "cursor/task",
          params: { taskId: "abc", status: "running", description: "Editing files" },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "system",
        threadId: "t1",
        subtype: "cursor_task:running",
      });
    });
  });

  describe("tool execution session updates", () => {
    it("emits ToolUse for tool_start sessionUpdate", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_start",
              toolCallId: "tc-1",
              toolName: "edit_file",
              toolInput: { file: "foo.ts", content: "bar" },
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolUse",
        threadId: "t1",
        toolCallId: "tc-1",
        toolName: "edit_file",
        toolInput: { file: "foo.ts", content: "bar" },
      });
      expect(acc.toolStartTimes.has("tc-1")).toBe(true);
    });

    it("emits ToolResult for tool_end sessionUpdate", () => {
      const acc = freshAcc();
      acc.toolStartTimes.set("tc-1", Date.now() - 3000);
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_end",
              toolCallId: "tc-1",
              output: "File edited successfully",
              isError: false,
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolResult",
        threadId: "t1",
        toolCallId: "tc-1",
        output: "File edited successfully",
        isError: false,
      });
      expect(acc.toolStartTimes.has("tc-1")).toBe(false);
    });

    it("handles alternative field names (actionId, actionName, parameters, result, success)", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_start",
              actionId: "ac-2",
              actionName: "run_command",
              parameters: { command: "ls" },
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolUse",
        toolCallId: "ac-2",
        toolName: "run_command",
        toolInput: { command: "ls" },
      });
    });

    it("emits ToolProgress with non-negative elapsedSeconds when tool_start preceded it", () => {
      const acc = freshAcc();
      // Simulate tool_start to populate toolStartTimes
      mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_start",
              toolCallId: "tc-progress-1",
              toolName: "edit_file",
            },
          },
        },
        "t1",
        acc,
      );
      expect(acc.toolStartTimes.has("tc-progress-1")).toBe(true);

      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_progress",
              toolCallId: "tc-progress-1",
              toolName: "edit_file",
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolProgress",
        threadId: "t1",
        toolCallId: "tc-progress-1",
        toolName: "edit_file",
      });
      const elapsed = (events[0] as { elapsedSeconds: number }).elapsedSeconds;
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });

    it("returns no events for tool_progress with unknown toolCallId", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_progress",
              toolCallId: "unknown-tc",
              toolName: "edit_file",
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });

    it("returns no events for tool_progress with no toolCallId or actionId", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_progress",
              toolName: "edit_file",
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });

    it("returns no events for tool_end with no toolCallId or actionId", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_end",
              output: "done",
              isError: false,
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });

    it("returns no events for agent_action_end with no toolCallId or actionId", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_action_end",
              result: "done",
              success: true,
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });
  });
});
