import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";

/**
 * Codex turns frequently interleave very short text deltas with shell tool
 * calls. The session.toolUse handler freezes the active narration segment, so
 * without coalescing we end up with rows like "the", "changed set and
 * therefore the only", "likely source of performance findings." — one logical
 * sentence chopped into 4 visible rows. flushPendingTextDeltas re-opens a
 * frozen tail when (a) the previous tail is short OR (b) the continuation
 * looks lowercase / punctuation-led so the user sees one flowing narration.
 */
describe("threadStore narration-segment coalescing", () => {
  beforeEach(() => {
    useThreadStore.setState({
      streamingByThread: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
      narrationSegmentsByThread: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function flush(queue: FrameRequestCallback[]) {
    while (queue.length > 0) queue.shift()!(0);
  }

  function setupRaf(): FrameRequestCallback[] {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    return queue;
  }

  it("merges a tiny frozen tail with the next continuation delta", () => {
    const queue = setupRaf();
    const tid = "thread-merge";
    const store = useThreadStore.getState();

    // Open segment with a short tail "the" and freeze it via a tool call.
    store.handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "the", isFinalResponse: false },
    });
    flush(queue);
    store.handleAgentEvent(tid, {
      method: "session.toolUse",
      params: { toolCallId: "t1", toolName: "Bash", toolInput: {} },
    });

    // New delta continues the segment after the tool finishes.
    store.handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: " changed set", isFinalResponse: false },
    });
    flush(queue);

    const segs = useThreadStore.getState().narrationSegmentsByThread[tid] ?? [];
    expect(segs.length).toBe(1);
    expect(segs[0]!.text).toBe("the changed set");
    expect(segs[0]!.endedAt).toBeUndefined();
  });

  it("does NOT merge when the previous segment was a long completed sentence", () => {
    const queue = setupRaf();
    const tid = "thread-keep-distinct";
    const store = useThreadStore.getState();

    const long = "I will read the file and then summarize what changed in this branch.";
    store.handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: long, isFinalResponse: false },
    });
    flush(queue);
    store.handleAgentEvent(tid, {
      method: "session.toolUse",
      params: { toolCallId: "t2", toolName: "Bash", toolInput: {} },
    });

    // Continuation starts uppercase and the prev ended with a period.
    store.handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "Now I have the result.", isFinalResponse: false },
    });
    flush(queue);

    const segs = useThreadStore.getState().narrationSegmentsByThread[tid] ?? [];
    expect(segs.length).toBe(2);
    expect(segs[0]!.text).toBe(long);
    expect(segs[1]!.text).toBe("Now I have the result.");
  });

  it("merges when the continuation is clearly lowercase / punctuation-led", () => {
    const queue = setupRaf();
    const tid = "thread-merge-lower";
    const store = useThreadStore.getState();

    const prev = "I am inspecting the changeset closely so this review is";
    store.handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: prev, isFinalResponse: false },
    });
    flush(queue);
    store.handleAgentEvent(tid, {
      method: "session.toolUse",
      params: { toolCallId: "t3", toolName: "Bash", toolInput: {} },
    });

    store.handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: " entirely the uncommitted worktree delta.", isFinalResponse: false },
    });
    flush(queue);

    const segs = useThreadStore.getState().narrationSegmentsByThread[tid] ?? [];
    expect(segs.length).toBe(1);
    expect(segs[0]!.text.endsWith("worktree delta.")).toBe(true);
  });
});
