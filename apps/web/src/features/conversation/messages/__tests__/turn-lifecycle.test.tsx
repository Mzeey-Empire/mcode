import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTurn, Message, TurnOutcome, TurnRuntimePhase } from "@mcode/contracts";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { shouldQueueActiveThreadSubmit } from "../../composer/submission/composer-submit-policy";
import { useMessageListData } from "../useMessageListData";
import { buildStableItems } from "../virtual-items";

const THREAD = "lifecycle-thread";
const EXECUTION = "current-execution";
const NOW = "2026-01-01T00:00:00Z";

function answer(id: string, executionId: string): Message & { outcome: TurnOutcome; outcomeExecutionId: string } {
  return {
    id, thread_id: THREAD, role: "assistant", content: "Saved answer", outcome: "interrupted",
    outcomeExecutionId: executionId, tool_calls: null, files_changed: null, cost_usd: null,
    tokens_used: null, timestamp: NOW, sequence: 1, attachments: null,
  };
}

function canonicalTurn(status: AgentTurn["status"], trigger: AgentTurn["trigger"]): AgentTurn {
  return {
    id: "canonical-turn", threadId: THREAD, status, trigger, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested",
    providerIdentities: [], startedAt: NOW, endedAt: null, createdAt: NOW, updatedAt: NOW,
  };
}

function useLifecycle() {
  const data = useMessageListData(THREAD);
  const running = useThreadStore((state) => state.runningThreadIds.has(THREAD));
  const rows = buildStableItems(data.messages, undefined, undefined, {
    threadId: THREAD, messageId: data.currentTurnMessageId, executionId: data.turnExecutionId ?? undefined,
  }, undefined, data.turnSummariesByMessageId, data.agentDisplayState);
  return { data, running, footers: rows.filter((row) => row.type === "persisted-turn-footer") };
}

afterEach(() => resetThreadStoreForTests());

describe("one lifecycle for the current turn", () => {
  it.each<TurnRuntimePhase>(["running", "finalizing"])("keeps %s active despite a stale saved outcome", (phase) => {
    const record = createEmptyThreadRecord();
    record.messages = [answer("previous-answer", "previous-execution"), answer("current-answer", EXECUTION)];
    record.currentTurnMessageId = "current-answer";
    resetThreadStoreForTests({ records: new Map([[THREAD, record]]) });
    useThreadStore.getState().applyThreadRuntimeSnapshot({ threadId: THREAD, turnExecutionId: EXECUTION, phase });
    const { result } = renderHook(useLifecycle);
    expect(result.current.running).toBe(true);
    expect(result.current.data.isAgentRunning).toBe(true);
    expect(shouldQueueActiveThreadSubmit(THREAD, false, null, false, "follow-up")).toBe(true);
    expect(result.current.footers.map((row) => [row.messageId, row.summary?.outcome]))
      .toEqual([["previous-answer", "interrupted"]]);
  });

  it("matches the current execution after reconnect even without a local response id", () => {
    const record = createEmptyThreadRecord();
    record.messages = [answer("current-answer", EXECUTION)];
    record.canonicalAgent.state.turns["canonical-turn"] = canonicalTurn("Interrupted", { kind: "user" });
    resetThreadStoreForTests({ records: new Map([[THREAD, record]]) });
    useThreadStore.getState().hydrateThreadRuntimes([{ threadId: THREAD, turnExecutionId: EXECUTION, phase: "running" }]);
    const { result } = renderHook(useLifecycle);
    expect(result.current.data.agentDisplayState).toEqual({ phase: "streaming" });
    expect(result.current.running).toBe(true);
    expect(result.current.footers).toEqual([]);
  });

  it("replaces a saved interrupted outcome with the current terminal decision", () => {
    const record = createEmptyThreadRecord();
    record.messages = [answer("current-answer", EXECUTION)];
    record.currentTurnMessageId = "current-answer";
    record.canonicalAgent.state.turns["canonical-turn"] = canonicalTurn("Running", { kind: "user" });
    resetThreadStoreForTests({ records: new Map([[THREAD, record]]) });
    useThreadStore.getState().applyThreadRuntimeSnapshot({ threadId: THREAD, turnExecutionId: EXECUTION, phase: "running" });
    const { result } = renderHook(useLifecycle);
    act(() => useThreadStore.getState().applyThreadRuntimeSnapshot({ threadId: THREAD, turnExecutionId: EXECUTION, phase: "cancelled" }));
    expect(result.current.running).toBe(false);
    expect(result.current.data.agentDisplayState).toEqual({ phase: "cancelled" });
    expect(result.current.footers.map((row) => row.summary?.outcome)).toEqual(["cancelled"]);
    expect(shouldQueueActiveThreadSubmit(THREAD, true, null, false, "follow-up")).toBe(false);
  });

  it("does not attach a previous canonical response to a new running execution", () => {
    const record = createEmptyThreadRecord();
    const previous = answer("previous-answer", "previous-execution");
    record.messages = [previous];
    record.canonicalAgent.state.turns["canonical-turn"] = canonicalTurn("Interrupted", { kind: "user" });
    record.canonicalAgent.state.items["previous-item"] = {
      id: "previous-item", threadId: THREAD, turnId: "canonical-turn", kind: "message",
      payload: { projection: "message", message: previous }, providerIdentities: [], createdAt: NOW, updatedAt: NOW,
    };
    resetThreadStoreForTests({ records: new Map([[THREAD, record]]) });
    useThreadStore.getState().applyThreadRuntimeSnapshot({ threadId: THREAD, turnExecutionId: EXECUTION, phase: "running" });
    const { result } = renderHook(useLifecycle);
    expect(result.current.data.currentTurnMessageId).toBe("");
    expect(result.current.data.agentDisplayState).toEqual({ phase: "streaming" });
    expect(result.current.footers.map((row) => [row.messageId, row.summary?.outcome]))
      .toEqual([["previous-answer", "interrupted"]]);
  });

  it("uses the canonical child lifecycle when the provider owns its execution", () => {
    const record = createEmptyThreadRecord();
    record.canonicalAgent.state.turns["canonical-turn"] = canonicalTurn("Running", {
      kind: "child", sourceThreadId: "parent", sourceTurnId: "parent-turn",
    });
    resetThreadStoreForTests({ records: new Map([[THREAD, record]]) });
    useThreadStore.getState().applyCanonicalReconnectRecoveries([{
      threadId: THREAD, mode: "snapshot",
      snapshot: { state: record.canonicalAgent.state, revision: { conversationRevision: 1, rosterRevision: 0 } },
    }]);
    const { result } = renderHook(useLifecycle);
    expect(result.current.data.agentDisplayState).toEqual({ phase: "streaming" });
    expect(result.current.running).toBe(true);
    expect(shouldQueueActiveThreadSubmit(THREAD, false, null, false, "follow-up")).toBe(true);
    const finished = structuredClone(record.canonicalAgent.state);
    finished.turns["canonical-turn"].status = "Completed";
    act(() => useThreadStore.getState().applyCanonicalReconnectRecoveries([{
      threadId: THREAD, mode: "snapshot",
      snapshot: { state: finished, revision: { conversationRevision: 2, rosterRevision: 0 } },
    }]));
    expect(result.current.running).toBe(false);
    expect(result.current.data.agentDisplayState).toEqual({ phase: "completed" });
    expect(shouldQueueActiveThreadSubmit(THREAD, true, null, false, "follow-up")).toBe(false);
  });
});
