import type { AgentEvent } from "@mcode/contracts";
import {
  getTestThreadStreaming,
  getTestThreadThoughtSegments,
  resetThreadStoreForTests,
} from "@/stores/thread-store-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";

function setupRaf(): FrameRequestCallback[] {
  const queue: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  return queue;
}

function flush(queue: FrameRequestCallback[]): void {
  while (queue.length > 0) queue.shift()!(0);
}

function emit(event: AgentEvent): void {
  useThreadStore.getState().handleAgentEvent(event);
}

function reasoning(threadId: string, delta: string, extra: { reasoningItemId?: string; done?: boolean } = {}): AgentEvent {
  return { type: "reasoningDelta", threadId, delta, ...extra };
}

function narration(threadId: string, delta: string): AgentEvent {
  return { type: "textDelta", threadId, delta, isFinalResponse: false };
}

function toolUse(threadId: string, toolCallId: string): AgentEvent {
  return { type: "toolUse", threadId, toolCallId, toolName: "Bash", toolInput: {} };
}

function segmentShape(threadId: string) {
  return (getTestThreadThoughtSegments(threadId) ?? []).map((segment) => ({
    text: segment.text,
    kind: segment.kind ?? "narration",
    open: segment.endedAt === undefined,
  }));
}

describe("threadStore reasoning segments", () => {
  beforeEach(() => {
    resetThreadStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("batches reasoning between tools into one closed reasoning segment kept out of the answer buffer", () => {
    const queue = setupRaf();
    const threadId = "thread-reasoning-between-tools";
    emit(narration(threadId, "I will check the config."));
    emit(toolUse(threadId, "t1"));
    emit(reasoning(threadId, "Weighing ", { reasoningItemId: "rs_1" }));
    emit(reasoning(threadId, "the options.", { reasoningItemId: "rs_1" }));
    expect(segmentShape(threadId)).toEqual([{ text: "I will check the config.", kind: "narration", open: false }]);
    flush(queue);
    emit(toolUse(threadId, "t2"));

    expect(segmentShape(threadId)).toEqual([
      { text: "I will check the config.", kind: "narration", open: false },
      { text: "Weighing the options.", kind: "reasoning", open: false },
    ]);
    expect(getTestThreadStreaming(threadId)).toBe("I will check the config.");
  });

  it("never merges a short reasoning delta into earlier narration, or narration into reasoning", () => {
    const queue = setupRaf();
    const threadId = "thread-reasoning-no-merge";
    emit(narration(threadId, "ok"));
    emit(toolUse(threadId, "t1"));
    emit(reasoning(threadId, "hm"));
    emit(narration(threadId, " and lowercase continuation"));
    flush(queue);

    expect(segmentShape(threadId)).toEqual([
      { text: "ok", kind: "narration", open: false },
      { text: "hm", kind: "reasoning", open: false },
      { text: " and lowercase continuation", kind: "narration", open: true },
    ]);
  });

  it("closes reasoning on done and ignores a re-delivered closed item", () => {
    const queue = setupRaf();
    const threadId = "thread-reasoning-done";
    emit(reasoning(threadId, "First idea.", { reasoningItemId: "rs_1" }));
    emit(reasoning(threadId, "", { reasoningItemId: "rs_1", done: true }));
    flush(queue);
    emit(reasoning(threadId, "First idea.", { reasoningItemId: "rs_1" }));
    emit(reasoning(threadId, "Second idea.", { reasoningItemId: "rs_2" }));
    flush(queue);

    expect(segmentShape(threadId)).toEqual([
      { text: "First idea.", kind: "reasoning", open: false },
      { text: "Second idea.", kind: "reasoning", open: true },
    ]);
  });

  it("starts the reasoning clock at an empty start fragment, not at the first text", () => {
    const queue = setupRaf();
    const threadId = "thread-reasoning-start";
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    emit(reasoning(threadId, "", { reasoningItemId: "rs_1" }));
    flush(queue);
    now.mockReturnValue(6_000);
    emit(reasoning(threadId, "Summary burst.", { reasoningItemId: "rs_1" }));
    emit(reasoning(threadId, "", { reasoningItemId: "rs_1", done: true }));
    flush(queue);

    const segments = getTestThreadThoughtSegments(threadId) ?? [];
    expect(segments.map(({ text, kind, startedAt, endedAt }) => ({ text, kind, startedAt, endedAt }))).toEqual([
      { text: "Summary burst.", kind: "reasoning", startedAt: 1_000, endedAt: 6_000 },
    ]);
  });

  it("ignores an empty done fragment when no reasoning block is open", () => {
    const queue = setupRaf();
    const threadId = "thread-reasoning-stray-done";
    emit(reasoning(threadId, "", { reasoningItemId: "rs_9", done: true }));
    flush(queue);

    expect(segmentShape(threadId)).toEqual([]);
  });

  it("closes open reasoning when final answer text starts", () => {
    const queue = setupRaf();
    const threadId = "thread-reasoning-final";
    emit(reasoning(threadId, "Planning the answer."));
    emit({ type: "textDelta", threadId, delta: "The answer.", isFinalResponse: true });
    flush(queue);

    expect(segmentShape(threadId)).toEqual([{ text: "Planning the answer.", kind: "reasoning", open: false }]);
    expect(getTestThreadStreaming(threadId)).toBe("The answer.");
  });
});
