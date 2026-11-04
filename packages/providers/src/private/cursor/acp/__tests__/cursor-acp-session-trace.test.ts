import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import {
  shouldEmitCursorSessionTrace,
  summarizeCursorSessionNotification,
  summarizeEmittedAgentEventsForTrace,
} from "../cursor-acp-session-trace.js";

describe("cursor-acp-session-trace", () => {
  it("records the envelope's structure and protocol state but none of its text", () => {
    const raw = summarizeCursorSessionNotification({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-7",
        status: "completed",
        rawInput: { path: "/home/me/.env" },
        rawOutput: { content: "OPENAI_KEY=abc123" },
        content: [{ type: "content", content: { type: "text", text: "file body" } }],
      },
    } as SessionNotification);

    expect(raw).toEqual({
      sessionId: "[2 chars]",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-7",
        status: "completed",
        rawInput: { path: "[13 chars]" },
        rawOutput: { content: "[17 chars]" },
        content: [{ type: "content", content: { type: "text", text: "[9 chars]" } }],
      },
    });
  });

  it("summarizes AgentEvent payloads without dumping large tool outputs", () => {
    const rows = summarizeEmittedAgentEventsForTrace([
      {
        type: AgentEventType.ToolUse,
        threadId: "t1",
        toolCallId: "c1",
        toolName: "Read",
        toolInput: { path: "/tmp/x.ts" },
      },
      {
        type: AgentEventType.ToolResult,
        threadId: "t1",
        toolCallId: "c1",
        output: "hello".repeat(1000),
        isError: false,
      },
    ]);

    expect(rows[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "c1",
      toolName: "Read",
      toolInputKeys: ["path"],
    });
    expect(rows[1]).toMatchObject({
      type: "toolResult",
      outputChars: 5000,
    });
  });

  it("drops chatty streaming chunks but keeps idle tool envelopes", () => {
    expect(
      shouldEmitCursorSessionTrace(
        { sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } as never },
        0,
      ),
    ).toBe(false);

    expect(
      shouldEmitCursorSessionTrace(
        {
          sessionId: "s",
          update: { sessionUpdate: "tool_call" } as SessionNotification["update"],
        },
        0,
      ),
    ).toBe(true);

    expect(
      shouldEmitCursorSessionTrace(
        {
          sessionId: "s",
          update: { sessionUpdate: "available_commands_update" } as SessionNotification["update"],
        },
        0,
      ),
    ).toBe(false);

    expect(
      shouldEmitCursorSessionTrace(
        {
          sessionId: "s",
          update: { sessionUpdate: "available_commands_update" } as SessionNotification["update"],
        },
        1,
      ),
    ).toBe(true);
  });
});
