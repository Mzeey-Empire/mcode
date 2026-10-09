import { describe, expect, it } from "vitest";
import type { Message } from "@mcode/contracts";
import { expandTranscriptNarrative, expandTranscriptToolGroups } from "../transcript-narrative-items";
import { createTranscriptItemProjector, type ChatVirtualItem, type PersistedNarrativeRecords, type TranscriptProjectionInput } from "../virtual-items";

describe("transcript narrative rows", () => {
  it.each([undefined, "pending-answer", "answer"])("renders hydrated live narrative once with response id %s", (messageId) => {
    const answer: Message = {
      id: "answer", thread_id: "thread", role: "assistant", content: "Final response", sequence: 2,
      outcomeExecutionId: "execution", timestamp: new Date(3000).toISOString(),
      tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, attachments: null,
    };
    const input: TranscriptProjectionInput = {
      messages: [answer], currentTurn: { threadId: "thread", executionId: "execution", messageId, responseKey: "live-answer" },
      agentDisplayState: { phase: "finalizing" }, agentStartTime: 1000, streamingText: answer.content,
      thoughtSegments: [{ text: "Checking", startedAt: 1000, endedAt: 1100, isExplicitNonFinal: true }],
      toolCalls: [0, 1].map((index) => ({ id: `tool-${index}`, toolName: "Bash", toolInput: { command: "pwd" }, output: "done", isError: false, isComplete: true, startedAt: 1200 + index, completedAt: 1300 + index })),
      persistedNarrativeByMessage: { answer: {
        hooks: [], thoughts: [{ id: "thought", message_id: "answer", text: "Checking", started_at: new Date(1000).toISOString(), ended_at: new Date(1100).toISOString(), sort_order: 0 }],
        tools: [0, 1].map((index) => ({ id: `tool-${index}`, message_id: "answer", parent_tool_call_id: null, tool_name: "Bash", input_summary: "pwd", output_summary: "done", status: "completed", started_at: new Date(1200 + index).toISOString(), completed_at: new Date(1300 + index).toISOString(), sort_order: index + 1 })),
      } },
    };
    for (const toolCalls of [input.toolCalls, []]) {
      const saved = input.persistedNarrativeByMessage?.answer;
      const persistedNarrativeByMessage = { answer: saved && { ...saved, tools: toolCalls.length ? saved.tools : [] } };
      const projected = createTranscriptItemProjector()({ ...input, toolCalls, persistedNarrativeByMessage });
      const narrative = expandTranscriptNarrative(projected, persistedNarrativeByMessage, new Set(), input.currentTurn);
      const rows = expandTranscriptToolGroups(narrative, new Set(narrative.map((row) => row.key)));
      expect(rows.filter((row) => row.type === "message")).toHaveLength(1);
      expect(rows.filter((row) => row.type === "narrative-row" && row.item.type === "thought")).toHaveLength(1);
      expect(rows.filter((row) => row.type === "tool-row")).toHaveLength(toolCalls.length);
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    }
  });

  it("omits hooks from live and saved narrative rows while retaining reasoning", () => {
    const live = expandTranscriptNarrative([{
      type: "narrative-flow", key: "live", toolCalls: [], startTime: 1000,
      hooks: [{ hookName: "Setup", hookType: "permission", status: "completed", startedAt: 1000, outputLines: [], fullOutput: [] }],
      thoughtSegments: [{ text: "Working", startedAt: 2000, endedAt: 2100, isExplicitNonFinal: true }],
      streamingText: "", isAgentRunning: true,
    }], {}, new Set());
    const saved = expandTranscriptNarrative([fold("saved", "answer", "Done")], { answer: { tools: [], thoughts: [{
      id: "thought", message_id: "answer", text: "Working", started_at: new Date(2000).toISOString(),
      ended_at: new Date(2100).toISOString(), sort_order: 2,
    }], hooks: [{
      id: "hook", message_id: "answer", hook_name: "Setup", tool_name: null, phase: "permission",
      payload: "{}", duration_ms: 1, did_block: false, started_at: new Date(1000).toISOString(),
      ended_at: new Date(1001).toISOString(), sort_order: 1,
    }] } }, new Set(["saved"]));
    expect(live.map(rowLabel)).toEqual(["thought"]);
    expect(saved.map(rowLabel)).toEqual(["work-fold", "thought"]);
  });

  it("keeps reasoning keys and order across live completion and cold cache hydration", () => {
    const answer = message("answer", "Final response", "execution");
    const flow: ChatVirtualItem = {
      type: "narrative-flow", key: "live", toolCalls: [], hooks: [], startTime: 1000,
      thoughtSegments: [1000, 2000].map((startedAt) => ({
        text: `Reasoning ${startedAt}`, startedAt, endedAt: startedAt + 10, isExplicitNonFinal: true,
      })),
      streamingText: "Final response", isAgentRunning: true,
    };
    const live = expandTranscriptNarrative([flow], {}, new Set(), { threadId: "thread", executionId: "execution", responseKey: "temporary-response" });
    const saved = expandTranscriptNarrative([
      fold("saved", answer.id, answer.content),
      { type: "message", key: answer.id, message: answer },
    ], { answer: { tools: [], hooks: [], thoughts: [1000, 2000].map((time, index) => ({
      id: `thought-${index}`, message_id: answer.id, text: `Reasoning ${time}`,
      started_at: new Date(time).toISOString(), ended_at: new Date(time + 10).toISOString(), sort_order: index,
    })) } }, new Set(["saved"]), { threadId: "thread" });
    expect(saved.slice(1, -1).map((row) => row.key)).toEqual(live.map((row) => row.key));
    expect(live.map((row) => row.type === "narrative-row" && row.item.type === "thought" ? row.item.segment.text : row.type))
      .toEqual(["Reasoning 1000", "Reasoning 2000"]);
    expect(saved.at(-1)).toMatchObject({ type: "message", message: { content: "Final response" } });
  });

  it("shows only the fold while it is closed and its rows once it opens", () => {
    const records = { answer: { tools: [], hooks: [], thoughts: [{
      id: "thought", message_id: "answer", text: "Working", started_at: new Date(1000).toISOString(),
      ended_at: new Date(1100).toISOString(), sort_order: 0,
    }] } };
    const items: ChatVirtualItem[] = [
      { ...fold("work-fold:answer", "answer", "Done"), approvalNote: "Manual approval selected." },
      { type: "message", key: "answer", message: message("answer", "Done") },
    ];
    expect(expandTranscriptNarrative(items, records, new Set()).map(rowLabel)).toEqual(["work-fold", "message"]);
    expect(expandTranscriptNarrative(items, records, new Set(["work-fold:answer"])).map(rowLabel))
      .toEqual(["work-fold", "fold-note", "thought", "message"]);
  });

  it("puts a settled live turn's rows under its fold instead of above the answer", () => {
    const live: ChatVirtualItem = {
      type: "narrative-flow", key: "live", toolCalls: [], hooks: [], startTime: 1000,
      thoughtSegments: [{ text: "Working", startedAt: 1000, endedAt: 1100, isExplicitNonFinal: true }],
      streamingText: "", isAgentRunning: false,
    };
    const items: ChatVirtualItem[] = [
      fold("work-fold:answer", "answer", "Done"),
      live,
      { type: "message", key: "answer", message: message("answer", "Done") },
    ];
    const turn = { threadId: "thread", executionId: "execution" };
    const closed = expandTranscriptNarrative(items, {}, new Set(), turn);
    const open = expandTranscriptNarrative(items, {}, new Set(["work-fold:answer"]), turn);
    expect(closed.map(rowLabel)).toEqual(["work-fold", "message"]);
    expect(open.map(rowLabel)).toEqual(["work-fold", "thought", "message"]);
    expect(open[1]!.key).toBe(expandTranscriptNarrative([live], {}, new Set(), turn)[0]!.key);
  });

  it.each([
    ["before records load", undefined],
    ["after records load", { answer: { tools: [], hooks: [], thoughts: [{
      id: "thought", message_id: "answer", text: "Done", started_at: new Date(1000).toISOString(),
      ended_at: new Date(1100).toISOString(), sort_order: 0, is_final_response: 1,
    }] } }],
  ])("omits the fold when a settling turn's only thought is the answer, %s", (_, persistedNarrativeByMessage) => {
    const projected = createTranscriptItemProjector()({
      messages: [message("answer", "Done", "execution")],
      currentTurn: { threadId: "thread", executionId: "execution", messageId: "answer" },
      agentDisplayState: { phase: "completed" }, agentStartTime: 1000, streamingText: undefined, toolCalls: [],
      thoughtSegments: [{ text: "Done", startedAt: 1000, endedAt: 1100 }],
      committedAssistantBody: "Done", persistedNarrativeByMessage,
    });
    expect(projected.filter((item) => item.type === "work-fold")).toEqual([]);
  });

  it("bounds persisted narrative expansion for very large saved tool histories", () => {
    const records: NonNullable<PersistedNarrativeRecords> = {
      hooks: [],
      thoughts: [],
      tools: Array.from({ length: 170 }, (_, index) => ({
        id: `tool-${String(index).padStart(3, "0")}`,
        message_id: "answer",
        parent_tool_call_id: null,
        tool_name: "Bash",
        input_summary: "pwd",
        output_summary: "done",
        status: "completed",
        started_at: new Date(1_000 + index).toISOString(),
        completed_at: new Date(2_000 + index).toISOString(),
        sort_order: index,
      })),
    };
    const rows = expandTranscriptNarrative([
      fold("saved", "answer", "Done"),
      { type: "message", key: "answer", message: message("answer", "Done") },
    ], { answer: records }, new Set(["saved"]));
    const expanded = expandTranscriptToolGroups(rows, new Set(rows.map((row) => row.key)));
    const toolRows = expanded.filter((row) => row.type === "tool-row");
    expect(toolRows).toHaveLength(32);
    expect(toolRows[0]).toMatchObject({ toolCall: { id: "tool-138" } });
    expect(toolRows.at(-1)).toMatchObject({ toolCall: { id: "tool-169" } });
  });
});

function fold(key: string, messageId: string, messageContent: string): Extract<ChatVirtualItem, { type: "work-fold" }> {
  return { type: "work-fold", key, messageId, messageContent, durationMs: null };
}

function message(id: string, content: string, outcomeExecutionId?: string): Message {
  return {
    id, thread_id: "thread", role: "assistant", content, sequence: 2, outcomeExecutionId,
    timestamp: new Date(3000).toISOString(),
    tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, attachments: null,
  };
}

function rowLabel(row: { type: string; item?: { type: string } }): string {
  return row.type === "narrative-row" && row.item ? row.item.type : row.type;
}
