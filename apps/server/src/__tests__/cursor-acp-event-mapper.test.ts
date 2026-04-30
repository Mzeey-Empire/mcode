import { describe, it, expect } from "vitest";
import {
  mapCursorAcpNotification,
  type CursorStreamAccumulator,
} from "../providers/cursor/cursor-acp-event-mapper.js";

function freshAcc(): CursorStreamAccumulator {
  return { assistantText: "", toolStartTimes: new Map() };
}

describe("mapCursorAcpNotification", () => {
  describe("agent_message_chunk (streaming text)", () => {
    it("emits TextDelta from a text content block", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello" },
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

    it("ignores non-text content blocks (e.g. image) without leaking text", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "image", data: "base64..." },
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toEqual([]);
      expect(acc.assistantText).toBe("");
    });

    it("accepts legacy `{ text: ... }` shape without explicit type discriminator", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "legacy" },
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "textDelta", delta: "legacy" });
    });
  });

  describe("agent_thought_chunk (reasoning)", () => {
    it("drops thought chunks without polluting assistant text", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "internal reasoning" },
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toEqual([]);
      expect(acc.assistantText).toBe("");
    });
  });

  describe("user_message_chunk (echo)", () => {
    it("drops user message echoes silently", () => {
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "hi" },
            },
          },
        },
        "t1",
        freshAcc(),
      );
      expect(events).toEqual([]);
    });
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

  describe("plan (TodoWrite synthesis)", () => {
    it("emits ToolUse(TodoWrite) + ToolResult for sessionUpdate=plan", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "plan",
              entries: [
                { content: "Fix the bug", priority: "high", status: "in_progress" },
                { content: "Write tests", priority: "medium", status: "pending" },
              ],
            },
          },
        },
        "t1",
        acc,
      );

      expect(events).toHaveLength(2);

      const [toolUse, toolResult] = events;
      expect(toolUse).toMatchObject({
        type: "toolUse",
        threadId: "t1",
        toolName: "TodoWrite",
      });

      const input = (toolUse as { toolInput: Record<string, unknown> }).toolInput;
      const todos = input.todos as Array<Record<string, unknown>>;
      expect(todos).toHaveLength(2);
      expect(todos[0]).toMatchObject({
        content: "Fix the bug",
        status: "in_progress",
        priority: "high",
      });
      expect(todos[1]).toMatchObject({
        content: "Write tests",
        status: "pending",
        priority: "medium",
      });

      expect(toolResult).toMatchObject({
        type: "toolResult",
        threadId: "t1",
        isError: false,
      });
    });

    it("returns empty for plan with non-array entries (defensive)", () => {
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: { sessionUpdate: "plan", entries: "not-an-array" },
          },
        },
        "t1",
        freshAcc(),
      );
      expect(events).toEqual([]);
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

  describe("tool_call (canonical ACP)", () => {
    it("emits ToolUse for a tool_call with title, kind, and rawInput", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-1",
              title: "Edit foo.ts",
              kind: "edit",
              rawInput: { file: "foo.ts", content: "bar" },
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
        toolName: "Edit foo.ts",
        toolInput: { file: "foo.ts", content: "bar" },
      });
      expect(acc.toolStartTimes.has("tc-1")).toBe(true);
    });

    it("falls back to kind when title is missing", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-2",
              kind: "search",
            },
          },
        },
        "t1",
        acc,
      );
      expect(events[0]).toMatchObject({ toolName: "search" });
    });

    it("emits ToolUse + ToolResult when tool_call already carries terminal status", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-3",
              title: "Read README.md",
              kind: "read",
              status: "completed",
              content: [
                { type: "content", content: { type: "text", text: "file body" } },
              ],
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "toolUse", toolCallId: "tc-3" });
      expect(events[1]).toMatchObject({
        type: "toolResult",
        toolCallId: "tc-3",
        output: "file body",
        isError: false,
      });
      // Inline-completed call must clear its start time so a stray later
      // update doesn't think we're still running.
      expect(acc.toolStartTimes.has("tc-3")).toBe(false);
    });

    it("returns no events for tool_call without toolCallId", () => {
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              title: "Anonymous",
              kind: "execute",
            },
          },
        },
        "t1",
        freshAcc(),
      );
      expect(events).toEqual([]);
    });
  });

  describe("tool_call_update (canonical ACP)", () => {
    it("emits ToolResult on status=completed for a known tool", () => {
      const acc = freshAcc();
      acc.toolStartTimes.set("tc-1", Date.now() - 3000);
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-1",
              status: "completed",
              content: [
                { type: "content", content: { type: "text", text: "done" } },
              ],
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolResult",
        toolCallId: "tc-1",
        output: "done",
        isError: false,
      });
      expect(acc.toolStartTimes.has("tc-1")).toBe(false);
    });

    it("falls back to rawOutput string when no content text is available", () => {
      const acc = freshAcc();
      acc.toolStartTimes.set("tc-raw", Date.now());
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-raw",
              status: "completed",
              rawOutput: "stdout text",
            },
          },
        },
        "t1",
        acc,
      );
      expect(events[0]).toMatchObject({
        type: "toolResult",
        output: "stdout text",
      });
    });

    it("stringifies non-string rawOutput to JSON", () => {
      const acc = freshAcc();
      acc.toolStartTimes.set("tc-obj", Date.now());
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-obj",
              status: "completed",
              rawOutput: { exit: 0, stdout: "ok" },
            },
          },
        },
        "t1",
        acc,
      );
      expect(events[0]).toMatchObject({
        type: "toolResult",
        output: '{"exit":0,"stdout":"ok"}',
      });
    });

    it("emits ToolResult with isError=true on status=failed", () => {
      const acc = freshAcc();
      acc.toolStartTimes.set("tc-fail", Date.now());
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-fail",
              status: "failed",
              rawOutput: "EACCES",
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolResult",
        toolCallId: "tc-fail",
        isError: true,
      });
    });

    it("emits ToolProgress heartbeat for non-terminal status of a known tool", () => {
      const acc = freshAcc();
      acc.toolStartTimes.set("tc-prog", Date.now() - 100);
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-prog",
              status: "in_progress",
              title: "Searching",
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolProgress",
        toolCallId: "tc-prog",
        toolName: "Searching",
      });
      const elapsed = (events[0] as { elapsedSeconds: number }).elapsedSeconds;
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });

    it("synthesizes ToolUse + ToolResult when tool_call_update arrives without prior tool_call", () => {
      const acc = freshAcc();
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-late",
              title: "Late tool",
              kind: "execute",
              status: "completed",
              rawOutput: "ok",
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "toolUse",
        toolCallId: "tc-late",
        toolName: "Late tool",
      });
      expect(events[1]).toMatchObject({
        type: "toolResult",
        toolCallId: "tc-late",
        output: "ok",
      });
    });

    it("drops tool_call_update with non-terminal status for an unknown toolCallId", () => {
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-unknown",
              status: "in_progress",
            },
          },
        },
        "t1",
        freshAcc(),
      );
      expect(events).toEqual([]);
    });

    it("returns no events for tool_call_update without toolCallId", () => {
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              status: "completed",
              rawOutput: "done",
            },
          },
        },
        "t1",
        freshAcc(),
      );
      expect(events).toEqual([]);
    });

    it("renders diff content blocks into a readable summary", () => {
      const acc = freshAcc();
      acc.toolStartTimes.set("tc-diff", Date.now());
      const events = mapCursorAcpNotification(
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-diff",
              status: "completed",
              content: [
                {
                  type: "diff",
                  path: "foo.ts",
                  oldText: "a",
                  newText: "b",
                },
              ],
            },
          },
        },
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      const output = (events[0] as { output: string }).output;
      expect(output).toContain("Diff: foo.ts");
      expect(output).toContain("--- old");
      expect(output).toContain("+++ new");
    });
  });
});
