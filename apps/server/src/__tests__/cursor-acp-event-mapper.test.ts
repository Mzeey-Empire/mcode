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
});
