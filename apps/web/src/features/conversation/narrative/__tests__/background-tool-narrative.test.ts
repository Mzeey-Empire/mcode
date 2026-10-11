import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/transport/types";
import { buildNarrativeItems, computeLiveStreamingText } from "../build-narrative";

function agentCall(overrides: Partial<ToolCall>): ToolCall {
  return { id: "agent-1", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false, ...overrides };
}

describe("live narrative around a backgrounded call", () => {
  const answer = "The agent keeps working in the background.";

  it("streams the turn's answer while a backgrounded call is still running", () => {
    const inputs = { toolCalls: [agentCall({ background: true })], hooks: [], thoughtSegments: [], streamingText: answer, isAgentRunning: true };
    expect(computeLiveStreamingText(inputs)).toBe(answer);
    expect(buildNarrativeItems(inputs).items.at(-1)).toEqual({ type: "delta", text: answer });
  });

  it("still holds the answer behind a foreground call", () => {
    const inputs = { toolCalls: [agentCall({})], hooks: [], thoughtSegments: [], streamingText: answer, isAgentRunning: true };
    expect(computeLiveStreamingText(inputs)).toBe("");
    expect(buildNarrativeItems(inputs).items.some((item) => item.type === "delta")).toBe(false);
  });
});
