import { describe, expect, it } from "vitest";
import type { Message } from "@mcode/contracts";
import { expandTranscriptNarrative } from "../transcript-narrative-items";
import type { ChatVirtualItem } from "../virtual-items";

describe("transcript narrative rows", () => {
  it("omits hooks from live and saved narrative rows while retaining reasoning", () => {
    const live = expandTranscriptNarrative([{
      type: "narrative-flow", key: "live", toolCalls: [], startTime: 1000,
      hooks: [{ hookName: "Setup", hookType: "permission", status: "completed", startedAt: 1000, outputLines: [], fullOutput: [] }],
      thoughtSegments: [{ text: "Working", startedAt: 2000, endedAt: 2100, isExplicitNonFinal: true }],
      streamingText: "", isAgentRunning: true,
    }], {});
    const saved = expandTranscriptNarrative([
      { type: "persisted-narrative", key: "saved", messageId: "answer", messageContent: "Done" },
    ], { answer: { tools: [], thoughts: [{
      id: "thought", message_id: "answer", text: "Working", started_at: new Date(2000).toISOString(),
      ended_at: new Date(2100).toISOString(), sort_order: 2,
    }], hooks: [{
      id: "hook", message_id: "answer", hook_name: "Setup", tool_name: null, phase: "permission",
      payload: "{}", duration_ms: 1, did_block: false, started_at: new Date(1000).toISOString(),
      ended_at: new Date(1001).toISOString(), sort_order: 1,
    }] } });
    for (const rows of [live, saved]) {
      expect(rows.map((row) => row.type === "narrative-row" ? row.item.type : row.type)).toEqual(["thought"]);
    }
  });

  it("keeps reasoning keys and order across live completion and cold cache hydration", () => {
    const answer: Message = {
      id: "answer", thread_id: "thread", role: "assistant", content: "Final response", sequence: 2,
      outcomeExecutionId: "execution", timestamp: new Date(3000).toISOString(),
      tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, attachments: null,
    };
    const flow: ChatVirtualItem = {
      type: "narrative-flow", key: "live", toolCalls: [], hooks: [], startTime: 1000,
      thoughtSegments: [1000, 2000].map((startedAt) => ({
        text: `Reasoning ${startedAt}`, startedAt, endedAt: startedAt + 10, isExplicitNonFinal: true,
      })),
      streamingText: "Final response", isAgentRunning: true,
    };
    const live = expandTranscriptNarrative([flow], {}, { threadId: "thread", executionId: "execution", responseKey: "temporary-response" });
    const saved = expandTranscriptNarrative([
      { type: "persisted-narrative", key: "saved", messageId: answer.id, messageContent: answer.content },
      { type: "message", key: answer.id, message: answer },
    ], { answer: { tools: [], hooks: [], thoughts: [1000, 2000].map((time, index) => ({
      id: `thought-${index}`, message_id: answer.id, text: `Reasoning ${time}`,
      started_at: new Date(time).toISOString(), ended_at: new Date(time + 10).toISOString(), sort_order: index,
    })) } }, { threadId: "thread" });
    expect(saved.slice(0, -1).map((row) => row.key)).toEqual(live.map((row) => row.key));
    expect(live.map((row) => row.type === "narrative-row" && row.item.type === "thought" ? row.item.segment.text : row.type))
      .toEqual(["Reasoning 1000", "Reasoning 2000"]);
    expect(saved.at(-1)).toMatchObject({ type: "message", message: { content: "Final response" } });
  });
});
