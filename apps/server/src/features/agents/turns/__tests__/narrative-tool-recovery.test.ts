import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { NarrativeTurnState } from "../../conversation/narrative/narrative-turn-state.js";
import { NarrativeRecoveryDelta, type PreparedNarrativeRecoveryDelta } from "../narrative-recovery-delta.js";
import { ACTIVE_TURN_RECOVERY_RETAINED_LIMITS } from "../active-turn-recovery-retention-policy.js";

const execution = { threadId: "thread", turnId: "turn", executionId: "execution" };
const thought = { kind: "narrationSegment", record: {
  id: "thought", message_id: "", text: "", started_at: "2026-09-25T12:00:00.000Z", ended_at: null, sort_order: 0,
} } satisfies ParentNarrativeRecoveryItem;

function setup(toolName = "Read") {
  const state = new NarrativeTurnState(execution);
  state.beginTurn(execution.threadId);
  state.openOrExtendThought(execution.threadId, "Keep this thought");
  state.closeOpenThought(execution.threadId);
  state.bufferToolCall(execution.threadId, { toolCallId: "tool", toolName,
    parentToolCallId: "parent", toolInput: toolName === "Agent" ? { description: "Initial agent" } : { file_path: "first.txt" } });
  const partial = new NarrativeRecoveryDelta();
  const full = new NarrativeRecoveryDelta();
  const checkpoint = () => {
    const snapshot = state.recoverySnapshot(execution.threadId);
    const actual = partial.prepare(snapshot);
    const expected = full.prepare(snapshot);
    expect(changes(actual)).toEqual(changes(expected));
    actual?.acknowledge();
    expected?.acknowledge();
    return actual;
  };
  checkpoint();
  const update = (toolCallId = "tool") => {
    const actual = partial.prepareToolUpdate(state.toolRecoveryItem(execution.threadId, toolCallId));
    const expected = full.prepare(state.recoverySnapshot(execution.threadId));
    expect(changes(actual)).toEqual(changes(expected));
    actual?.acknowledge();
    expected?.acknowledge();
    return actual;
  };
  return { state, partial, checkpoint, update };
}

function changes(delta: PreparedNarrativeRecoveryDelta | null) {
  return delta && { items: delta.items, discardedItemIds: delta.discardedItemIds };
}

function toolRecord() {
  const { state } = setup();
  const item = state.toolRecoveryItem(execution.threadId, "tool");
  if (!item) throw new Error("Expected buffered tool");
  return item;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
});
afterEach(() => { vi.useRealTimers(); });

describe("targeted tool recovery", () => {
  it("matches full recovery for output, metadata removal, duplicates and later full checkpoints", () => {
    const { state, update, checkpoint } = setup();
    state.updateBufferedToolCallOutput(execution.threadId, "tool", "first output", false,
      { file_path: "updated.txt" }, { exitCode: 0, outputTruncated: true, outputTotalBytes: 500 });
    const first = update();
    expect(first?.items).toMatchObject([{ kind: "toolCall", record: {
      id: "tool", parent_tool_call_id: "parent", input_summary: "updated.txt", output_summary: "first output",
      exit_code: 0, output_truncated: 1, output_total_bytes: 500,
    } }]);
    state.updateBufferedToolCallOutput(execution.threadId, "tool", "second output", true);
    expect(update()?.items).toMatchObject([{ record: { status: "failed", exit_code: null, output_total_bytes: null } }]);
    state.updateBufferedToolCallOutput(execution.threadId, "tool", "second output", true);
    expect(update()).toBeNull();
    expect(checkpoint()).toBeNull();
    state.openOrExtendThought(execution.threadId, "New thought");
    expect(checkpoint()?.items).toHaveLength(1);
    state.takeOpenThought(execution.threadId);
    expect(checkpoint()?.discardedItemIds).toHaveLength(1);
  });

  it("preserves parent and Agent metadata through a targeted result after a duplicate tool use", () => {
    const { state, update, checkpoint } = setup("Agent");
    state.bufferToolCall(execution.threadId, { toolCallId: "tool", toolName: "Agent",
      parentToolCallId: "reconciled-parent", toolInput: { description: "Reviewer", agentId: "agent-7", prompt: "Review changes" } });
    checkpoint();
    state.updateBufferedToolCallOutput(execution.threadId, "tool", "Reviewed", false,
      { description: "Updated reviewer", agentId: "agent-7", prompt: "Review final changes", durationMs: 123 });
    expect(update()?.items).toMatchObject([{ record: { parent_tool_call_id: "reconciled-parent",
      subagent_agent_id: "agent-7", subagent_prompt: "Review final changes", subagent_duration_ms: 123 } }]);
    expect(checkpoint()).toBeNull();
  });

  it("does nothing for an unknown tool and returns an owned projection", () => {
    const { state, update, checkpoint } = setup();
    state.updateBufferedToolCallOutput(execution.threadId, "unknown", "ignored", false);
    expect(update("unknown")).toBeNull();
    const projected = state.toolRecoveryItem(execution.threadId, "tool");
    if (!projected) throw new Error("Expected buffered tool");
    projected.record.output_summary = "Mutated consumer copy";
    expect(checkpoint()).toBeNull();
  });

  it("keeps failed updates retryable and fences obsolete acknowledgements", () => {
    const { state, partial } = setup();
    state.updateBufferedToolCallOutput(execution.threadId, "tool", "done", false);
    const item = state.toolRecoveryItem(execution.threadId, "tool");
    const first = partial.prepareToolUpdate(item);
    const retry = partial.prepareToolUpdate(item);
    expect(changes(retry)).toEqual(changes(first));
    retry?.acknowledge();
    expect(partial.prepareToolUpdate(item)).toBeNull();
    expect(() => first?.acknowledge()).toThrow("already superseded");
    expect(partial.prepare(state.recoverySnapshot(execution.threadId))).toBeNull();
    expect(() => new NarrativeRecoveryDelta().prepareToolUpdate(item)).toThrow("full checkpoint");
  });

  it("checks total retained bytes and recovers the accounting after shrinkage and a full checkpoint", () => {
    const tool = toolRecord();
    const padding = ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxBytes
      - Buffer.byteLength(JSON.stringify(tool)) - Buffer.byteLength(JSON.stringify(thought)) - 32;
    const retainedThought = { ...thought, record: { ...thought.record, text: "x".repeat(padding) } };
    const delta = new NarrativeRecoveryDelta();
    delta.prepare([retainedThought, tool])?.acknowledge();
    const enlarged = { ...tool, record: { ...tool.record, output_summary: "x".repeat(100) } };
    expect(() => delta.prepareToolUpdate(enlarged)).toThrow("retained byte capacity");
    delta.prepare([thought, tool])?.acknowledge();
    delta.prepareToolUpdate(enlarged)?.acknowledge();
    delta.prepareToolUpdate(tool)?.acknowledge();
    expect(delta.prepare([thought, tool])).toBeNull();
    expect(() => delta.prepareToolUpdate({ ...tool, record: { ...tool.record,
      output_summary: "x".repeat(ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxBytes) } })).toThrow("active-turn byte limit");
  });

  it("checks the retained record count even when only one tool changes", () => {
    const tool = toolRecord();
    const delta = new NarrativeRecoveryDelta();
    const thoughts = Array.from({ length: ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxRecords }, (_, index) => ({
      ...thought, record: { ...thought.record, id: `thought-${index}` },
    }));
    delta.prepare([...thoughts, tool])?.acknowledge();
    expect(() => delta.prepareToolUpdate({ ...tool, record: { ...tool.record, output_summary: "done" } }))
      .toThrow("retained record capacity");
  });

  it("counts duplicate snapshot identities even when their full checkpoint has no changes", () => {
    const tool = toolRecord();
    const delta = new NarrativeRecoveryDelta();
    const state = new NarrativeTurnState(execution);
    state.openHook(execution.threadId, { hookName: "check", toolName: null, phase: "pre", payload: "", sortOrder: 0 });
    const hook = state.recoverySnapshot(execution.threadId).find((item) => item.kind === "hook");
    if (!hook) throw new Error("Expected hook recovery item");
    const repeated = { ...hook, record: { ...hook.record, payload: "x".repeat(130_900) } };
    delta.prepare([repeated, tool])?.acknowledge();
    expect(delta.prepare([repeated, repeated, tool])).toBeNull();
    expect(() => delta.prepareToolUpdate({ ...tool, record: { ...tool.record, output_summary: "done" } }))
      .toThrow("retained byte capacity");
    expect(delta.prepare([repeated, tool])).toBeNull();
    expect(delta.prepareToolUpdate({ ...tool, record: { ...tool.record, output_summary: "done" } })).not.toBeNull();

    const repeatedIds = new NarrativeRecoveryDelta();
    repeatedIds.prepare([thought, tool])?.acknowledge();
    expect(repeatedIds.prepare([...Array.from({ length: ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxRecords }, () => thought), tool])).toBeNull();
    expect(() => repeatedIds.prepareToolUpdate(tool)).toThrow("retained record capacity");
  });
});
