import { describe, expect, it } from "vitest";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import {
  summarizeAgentEventsForTrace,
  summarizeCodexNotificationParams,
} from "../../private/codex/codex-trace.js";

describe("codex-trace", () => {
  it("summarizeCodexNotificationParams extracts collab item fields", () => {
    const s = summarizeCodexNotificationParams("item/completed", {
      item: {
        type: "collabAgentToolCall",
        id: "item-1",
        toolKind: "delegate",
      },
    });
    expect(s).toEqual({
      itemType: "collabAgentToolCall",
      itemId: "item-1",
      toolKind: "delegate",
      functionName: undefined,
    });
  });

  it("records message deltas by length without their text", () => {
    const text = "the contents of secrets.txt";
    const raw = summarizeCodexNotificationParams("item/agentMessage/delta", { itemId: "i1", delta: text });
    const mapped = summarizeAgentEventsForTrace([{ type: AgentEventType.TextDelta, threadId: "t1", delta: text }]);

    expect(raw).toEqual({ itemId: "i1", deltaLen: text.length });
    expect(JSON.stringify(mapped)).not.toContain("secrets");
    expect(mapped[0]).toMatchObject({ type: "textDelta", len: text.length });
  });

  it("summarizeAgentEventsForTrace includes parentToolCallId when present", () => {
    const toolUse: AgentEvent = {
      type: AgentEventType.ToolUse,
      threadId: "t1",
      toolCallId: "c1",
      toolName: "Agent",
      toolInput: { a: 1 },
      parentToolCallId: "parent-9",
    };
    const rows = summarizeAgentEventsForTrace([toolUse]);
    expect(rows[0]).toMatchObject({
      type: "toolUse",
      toolName: "Agent",
      toolCallId: "c1",
      parentToolCallId: "parent-9",
    });
  });

  it("summarizes MCP startup status with bounded redacted diagnostics", () => {
    const s = summarizeCodexNotificationParams("mcpServer/startupStatus/updated", {
      threadId: "thread-1",
      name: "mcode",
      status: "failed",
      failureReason: "Bearer super-secret-credential caused startup failure",
      error: "authorization=another-secret-value",
    });

    expect(s).toMatchObject({
      threadId: "thread-1",
      name: "mcode",
      status: "failed",
      errorPreview: "authorization=[redacted]",
      failureReasonPreview: "Bearer [redacted] caused startup failure",
    });
    expect(JSON.stringify(s)).not.toContain("super-secret-credential");
    expect(JSON.stringify(s)).not.toContain("another-secret-value");
  });

  it("summarizes ready MCP startup status without diagnostics", () => {
    expect(
      summarizeCodexNotificationParams("mcpServer/startupStatus/updated", {
        name: "mcode",
        status: "ready",
      }),
    ).toEqual({
      name: "mcode",
      status: "ready",
      errorPreview: undefined,
      failureReasonPreview: undefined,
    });
  });

  it("retains a bounded diagnostic preview", () => {
    const summary = summarizeCodexNotificationParams("mcpServer/startupStatus/updated", {
      name: "mcode",
      status: "failed",
      failureReason: "x".repeat(400),
    });

    expect(String(summary.failureReasonPreview)).toHaveLength(257);
    expect(String(summary.failureReasonPreview).endsWith("…")).toBe(true);
  });
});
