import { createMockMessage } from "@mcode/contracts/testing";
import { createAgentModelState, type AgentModelState, type AgentTurn } from "@mcode/contracts/compat/agent-model";
import { type Message } from "@mcode/contracts/models/message";
import { describe, expect, it } from "vitest";
import { recoverParentNarrative, steeredUserMessages } from "./parent-narrative-recovery";
import { createEmptyThreadRecord, type ThreadRecord } from "./thread-record";

const NOW = "2026-10-10T12:00:00.000Z";
const THREAD = "parent-thread";
const EXECUTION = "00000000-0000-4000-8000-000000000001";
const MESSAGE = "turn-message";

const receipt = {
  id: "receipt-1", message_id: "", tool_call_id: "bash-1", kind: "command" as const, subject_label: "rm -rf build",
  outcome: { status: "denied" as const, choiceLabel: "Deny" }, origin: null, decided_at: NOW, sort_order: 2,
};
const tool = {
  id: "bash-1", message_id: "", parent_tool_call_id: null, tool_name: "Bash", input_summary: "{}", output_summary: "",
  status: "failed", started_at: NOW, completed_at: NOW, sort_order: 1,
};

function turnState(status: AgentTurn["status"]): AgentModelState {
  const state = createAgentModelState();
  state.turns.parent = {
    id: "parent", threadId: THREAD, executionId: EXECUTION, status, trigger: { kind: "user" },
    permissionMode: "full", approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null,
    providerIdentities: [], startedAt: NOW, providerStartedAt: null, ending: null, endedAt: status === "Running" ? null : NOW, createdAt: NOW, updatedAt: NOW,
  };
  state.items.tool = {
    id: "tool", threadId: THREAD, turnId: "parent", kind: "tool-call", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
    payload: { projection: "toolCall", record: tool },
  };
  state.items.receipt = {
    id: "receipt", threadId: THREAD, turnId: "parent", kind: "system", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
    payload: { projection: "approval", record: receipt },
  };
  return state;
}

function finishedRecord(patch: Partial<ThreadRecord> = {}): ThreadRecord {
  return { ...createEmptyThreadRecord(), runtimePhase: "completed", turnExecutionId: EXECUTION, currentTurnMessageId: MESSAGE, ...patch };
}

describe("recoverParentNarrative", () => {
  it("keeps a finished turn's fold and receipt in the message cache that outlives the next turn", () => {
    const patch = recoverParentNarrative(THREAD, turnState("Completed"), finishedRecord());

    expect(patch.narrativeByMessage).toEqual({
      [MESSAGE]: {
        tools: [{ ...tool, message_id: MESSAGE }],
        thoughts: [],
        hooks: [],
        approvals: [{ ...receipt, message_id: MESSAGE }],
      },
    });
  });

  it("merges into an already loaded bucket, letting the live record win", () => {
    const loadedThought = { id: "thought-1", message_id: MESSAGE, text: "Checking the build", started_at: NOW, ended_at: NOW, sort_order: 0 };
    const staleReceipt = { ...receipt, message_id: MESSAGE, subject_label: "stale" };
    const record = finishedRecord({
      narrativeByMessage: {
        [MESSAGE]: { tools: [], thoughts: [loadedThought], hooks: [], approvals: [staleReceipt] },
        "older-message": { tools: [], thoughts: [], hooks: [], approvals: [] },
      },
    });

    const patch = recoverParentNarrative(THREAD, turnState("Completed"), record);

    expect(patch.narrativeByMessage?.[MESSAGE]).toEqual({
      tools: [{ ...tool, message_id: MESSAGE }],
      thoughts: [loadedThought],
      hooks: [],
      approvals: [{ ...receipt, message_id: MESSAGE }],
    });
    expect(patch.narrativeByMessage?.["older-message"]).toEqual({ tools: [], thoughts: [], hooks: [], approvals: [] });
  });

  it("keeps a background call running after its turn ends until its own result settles it", () => {
    const held = { ...tool, id: "agent-bg", tool_name: "Agent", status: "running", background: true, completed_at: null };
    const state = turnState("Completed");
    state.items.tool = { ...state.items.tool, payload: { projection: "toolCall", record: held } };

    const patch = recoverParentNarrative(THREAD, state, finishedRecord());

    expect(patch.toolCalls).toEqual([expect.objectContaining({ id: "agent-bg", background: true, isComplete: false })]);
    expect(patch.narrativeByMessage?.[MESSAGE]?.tools).toEqual([{ ...held, message_id: MESSAGE }]);

    const settled = { ...held, status: "completed", output_summary: "Survey done", completed_at: NOW };
    state.items.tool = { ...state.items.tool, payload: { projection: "toolCall", record: settled } };
    const settledPatch = recoverParentNarrative(THREAD, state, finishedRecord());

    expect(settledPatch.toolCalls).toEqual([expect.objectContaining({ id: "agent-bg", isComplete: true, output: "Survey done" })]);
  });

  it("keeps a background call's steps running after its turn ends", () => {
    const held = { ...tool, id: "agent-bg", tool_name: "Agent", status: "running", background: true, completed_at: null };
    const step = { ...tool, id: "bash-step", tool_name: "Bash", parent_tool_call_id: "agent-bg", status: "running", completed_at: null };
    const state = turnState("Completed");
    state.items.tool = { ...state.items.tool, payload: { projection: "toolCall", record: held } };
    state.items.step = { ...state.items.tool, id: "step", payload: { projection: "toolCall", record: step } };

    const patch = recoverParentNarrative(THREAD, state, finishedRecord());

    expect(patch.toolCalls).toEqual([
      expect.objectContaining({ id: "agent-bg", isComplete: false }),
      expect.objectContaining({ id: "bash-step", isComplete: false }),
    ]);
  });

  it("leaves the cache alone while the turn is still running", () => {
    const record = finishedRecord({ runtimePhase: "idle" });

    const patch = recoverParentNarrative(THREAD, turnState("Running"), record);

    expect(patch.narrativeByMessage).toBeUndefined();
  });
});

function userMessage(id: string, content: string, sequence: number): Message {
  return createMockMessage({
    id,
    thread_id: THREAD,
    role: "user",
    content,
    timestamp: NOW,
    sequence,
    is_internal: false,
  });
}

function withMessage(state: AgentModelState, message: Message): AgentModelState {
  state.items[`message:${message.id}`] = {
    id: `message:${message.id}`, threadId: THREAD, turnId: "parent", kind: "message", providerIdentities: [],
    createdAt: NOW, updatedAt: NOW, payload: { projection: "message", message },
  };
  return state;
}

describe("steeredUserMessages", () => {
  const prompt = userMessage("prompt", "Run sleep 40", 1);
  const steer = userMessage("steer", "Also reply with ONE", 3);
  const running = (): ThreadRecord => finishedRecord({ runtimePhase: "idle", messages: [prompt] });

  it("returns a message the running turn took after its prompt", () => {
    const state = withMessage(withMessage(turnState("Running"), prompt), steer);

    expect(steeredUserMessages(THREAD, state, running())).toEqual([steer]);
  });

  it("returns nothing once the steer is in the transcript", () => {
    const state = withMessage(withMessage(turnState("Running"), prompt), steer);

    expect(steeredUserMessages(THREAD, state, { ...running(), messages: [prompt, steer] })).toEqual([]);
  });

  it("leaves an unloaded transcript for the full fetch", () => {
    const state = withMessage(turnState("Running"), steer);

    expect(steeredUserMessages(THREAD, state, { ...running(), messages: [] })).toEqual([]);
  });
});
