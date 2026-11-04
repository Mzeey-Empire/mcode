import { describe, expect, it } from "vitest";
import { summarizeClaudeStreamMessage } from "../claude-stream-trace.js";

describe("summarizeClaudeStreamMessage", () => {
  it("keeps result termination flags without result text", () => {
    const summary = summarizeClaudeStreamMessage({
      type: "result", terminal_reason: "aborted_streaming", stop_reason: "tool_use",
      is_error: false, result: "private answer",
    });
    expect(JSON.parse(JSON.stringify(summary))).toEqual({
      type: "result", terminalReason: "aborted_streaming", stopReason: "tool_use", isError: false,
    });
  });

  it("keeps task notification ids and status without its report or file path", () => {
    const summary = summarizeClaudeStreamMessage({
      type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "tool-1",
      status: "completed", summary: "private report", output_file: "/private/output",
    });
    expect(JSON.parse(JSON.stringify(summary))).toEqual({
      type: "system", subtype: "task_notification", taskId: "task-1", toolUseId: "tool-1", status: "completed",
    });
  });

  it("keeps an unknown command lifecycle's uuid and state and ignores fields of the wrong type", () => {
    const summary = summarizeClaudeStreamMessage({
      type: "command_lifecycle", uuid: "message-1", state: "aborted", phase: 1, status: {},
      task_id: false, tool_use_id: [], terminal_reason: {}, stop_reason: false, is_error: "true", aborted: "false",
      description: "private command",
    });
    expect(JSON.parse(JSON.stringify(summary))).toEqual({ type: "command_lifecycle", uuid: "message-1", state: "aborted" });
  });

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
