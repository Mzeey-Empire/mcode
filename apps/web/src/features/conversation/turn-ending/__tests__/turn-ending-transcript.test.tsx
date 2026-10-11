import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentModelState, type AgentModelState, type AgentTurn, type AgentTurnEnding, type Message } from "@mcode/contracts";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { useMessageListData } from "../../messages/useMessageListData";
import { useMessageListItems } from "../../messages/useMessageListItems";

const THREAD = "ending-transcript-thread";
const NO_FOLDS = new Set<string>();
const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 12, 0, second)).toISOString();
const FAILED: AgentTurnEnding = { outcome: "errored", failure: { kind: "fatal", provider: "codex", message: "boom" } };

function message(id: string, role: "user" | "assistant", second: number): Message {
  return {
    id, thread_id: THREAD, role, content: id, tool_calls: null, files_changed: null, cost_usd: null,
    tokens_used: null, timestamp: at(second), sequence: second, attachments: null,
  };
}

function turn(id: string, second: number, fields: Partial<AgentTurn>): AgentTurn {
  return {
    id, threadId: THREAD, status: "Completed", trigger: { kind: "user" }, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null, providerIdentities: [],
    startedAt: at(second), providerStartedAt: at(second), endedAt: at(second + 5), ending: null,
    createdAt: at(second), updatedAt: at(second + 5), ...fields,
  };
}

/** Loads persisted messages and canonical turns the way a reload does: a record plus a canonical snapshot. */
function hydrate(messagesByTurn: Record<string, Message[]>, turns: AgentTurn[]) {
  const state: AgentModelState = createAgentModelState();
  for (const value of turns) state.turns[value.id] = value;
  for (const [turnId, messages] of Object.entries(messagesByTurn)) {
    for (const value of messages) {
      state.items[`item-${value.id}`] = {
        id: `item-${value.id}`, threadId: THREAD, turnId, kind: "message", providerIdentities: [],
        payload: { projection: "message", message: value }, createdAt: value.timestamp, updatedAt: value.timestamp,
      };
    }
  }
  const record = createEmptyThreadRecord();
  record.messages = Object.values(messagesByTurn).flat();
  resetThreadStoreForTests({ records: new Map([[THREAD, record]]) });
  act(() => useThreadStore.getState().applyCanonicalReconnectRecoveries([{
    threadId: THREAD, mode: "snapshot", snapshot: { state, revision: { conversationRevision: 1, rosterRevision: 0 } },
  }]));
}

function useTranscript() {
  const data = useMessageListData(THREAD);
  const { items } = useMessageListItems({ ...data, expandedFolds: NO_FOLDS, expandedGroups: NO_FOLDS });
  return items.flatMap((item) => {
    if (item.type === "message") return [`message:${item.message.id}`];
    if (item.type === "turn-end-notice") return [`notice:${item.messageId}:${item.notice.title}`];
    return [];
  });
}

afterEach(() => resetThreadStoreForTests());

describe("turn endings in the reloaded transcript", () => {
  it("shows a retried turn once, with only the latest attempt's answer and notice", () => {
    hydrate(
      { t1: [message("u1", "user", 0), message("a1", "assistant", 1)], "t1-retry": [message("u1-retry", "user", 10), message("a1-retry", "assistant", 11)] },
      [turn("t1", 0, { status: "Errored", ending: FAILED }), turn("t1-retry", 10, { status: "Errored", ending: FAILED, attemptOf: "t1" })],
    );

    const { result } = renderHook(useTranscript);

    expect(result.current).toEqual([
      "message:u1",
      "message:a1-retry",
      "notice:a1-retry:The provider couldn't finish this turn",
    ]);
  });

  it("keeps a Mcode stop's attribution after reload", () => {
    hydrate(
      { t1: [message("u1", "user", 0)] },
      [turn("t1", 0, { status: "Cancelled", ending: { outcome: "cancelled", stop: { by: "mcode", reason: "approval_unanswerable" } } })],
    );

    const { result } = renderHook(useTranscript);

    expect(result.current).toEqual(["message:u1", "notice:u1:Stopped by Mcode"]);
  });
});
