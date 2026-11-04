import { describe, expect, it } from "vitest";
import { summarizeClaudeStreamMessage } from "../claude-stream-trace.js";

describe("summarizeClaudeStreamMessage", () => {
  it("places a sub-agent's tool call under its parent without recording text or input", () => {
    const summary = summarizeClaudeStreamMessage({
      type: "assistant",
      parent_tool_use_id: "toolu_task_1",
      message: {
        content: [
          { type: "text", text: "Reading the secrets file now" },
          { type: "tool_use", id: "toolu_read_2", name: "Read", input: { file_path: "/home/me/.env" } },
        ],
      },
    });

    expect(summary).toEqual({
      type: "assistant",
      subtype: undefined,
      eventType: undefined,
      parent: "toolu_task_1",
      tools: [{ name: "Read", id: "toolu_read_2" }],
      results: undefined,
    });
  });

  it("records which tool calls finished and whether they failed, without their output", () => {
    const summary = summarizeClaudeStreamMessage({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_mcp_3", is_error: true, content: "OPENAI_KEY=abc" },
          { type: "tool_result", tool_use_id: "toolu_read_2", content: "file body" },
        ],
      },
    });

    expect(summary.parent).toBeUndefined();
    expect(summary.results).toEqual([
      { id: "toolu_mcp_3", isError: true },
      { id: "toolu_read_2", isError: false },
    ]);
    expect(JSON.stringify(summary)).not.toContain("OPENAI_KEY");
  });

  it("names a tool call as soon as its streamed block starts", () => {
    const summary = summarizeClaudeStreamMessage({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_mcp_4", name: "mcp__mcode__delegate_task" } },
    });

    expect(summary).toMatchObject({
      eventType: "content_block_start",
      tools: [{ name: "mcp__mcode__delegate_task", id: "toolu_mcp_4" }],
    });
  });
});
