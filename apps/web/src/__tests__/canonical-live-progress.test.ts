// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptedCanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { CanonicalAgentProgressFrame } from "@mcode/contracts/models/canonical-agent-progress";
import { useThreadStore } from "@/stores/threadStore";
import { getTestThreadStreaming, resetThreadStoreForTests, seedThreadRecord } from "@/stores/thread-store-test-utils";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-live";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const EPOCH = "00000000-0000-4000-8000-000000000002";
const ACCEPTED_AT = "2026-11-06T12:00:00.000Z";
const TEXT_ITEM_ID = `assistant-response-text:${EXECUTION_ID}`;

function textDelta(delta: string): AgentEvent {
  return { type: "textDelta", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, delta, isFinalResponse: true };
}

function envelope(sequence: number, payload: AcceptedCanonicalAgentEventEnvelope["payload"], itemId?: string): AcceptedCanonicalAgentEventEnvelope {
  return {
    eventId: `accepted:${sequence}`,
    routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, ...(itemId ? { itemId } : {}) },
    sourceProviderId: "claude",
    sourceIdentities: [],
    acceptedSequence: sequence,
    serverTimestamps: { acceptedAt: ACCEPTED_AT },
    payload,
    progressPosition: { epoch: EPOCH, sequence },
  };
}

function accepted(events: AcceptedCanonicalAgentEventEnvelope[]): CanonicalAgentProgressFrame {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) throw new Error("empty fixture");
  return { phase: "accepted", threadId: THREAD_ID, epoch: EPOCH, from: first.progressPosition.sequence - 1,
    through: last.progressPosition.sequence, events };
}

/** The server numbers live frames in send order, so each new frame here takes the next number. */
let lastLiveSequence = 0;

function live(after: number, delta: string, epoch = EPOCH, liveSequence = ++lastLiveSequence): CanonicalAgentProgressFrame {
  return { phase: "live", threadId: THREAD_ID, epoch, after, liveSequence, events: [textDelta(delta)] };
}

/** The server's checkpoint for live text: the saved text item, with no publication to dispatch again. */
function checkpoint(sequence: number, content: string): AcceptedCanonicalAgentEventEnvelope {
  return envelope(sequence, { type: "item.recorded", item: { id: TEXT_ITEM_ID, threadId: THREAD_ID, turnId: TURN_ID,
    kind: "message", providerIdentities: [], payload: { projection: "assistantText", content, isStreaming: true },
    createdAt: ACCEPTED_AT, updatedAt: ACCEPTED_AT } }, TEXT_ITEM_ID);
}

function replica() {
  const record = useThreadStore.getState().records.get(THREAD_ID);
  if (!record) throw new Error("missing thread record");
  return record.canonicalAgent;
}

/** Thread store coalesces text deltas on animation frames; run each frame on the next microtask. */
async function flushFrames(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("canonical live progress", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback): number => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    lastLiveSequence = 0;
    clearRecordCache();
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });
    useThreadStore.setState({
      records: seedThreadRecord(THREAD_ID, { runtimePhase: "running", turnExecutionId: EXECUTION_ID }),
      runningThreadIds: new Set([THREAD_ID]),
    });
    useThreadStore.getState().handleCanonicalProgress(accepted([envelope(1, { type: "publication.recorded",
      publicationId: "1", event: textDelta("Hello") })]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams a live piece right after its accepted position without moving any saved position", async () => {
    const before = replica();
    useThreadStore.getState().handleCanonicalProgress(live(1, " world"));
    await flushFrames();
    expect(getTestThreadStreaming(THREAD_ID)).toBe("Hello world");
    expect(replica()).toBe(before);
    expect(replica().progress).toMatchObject({ acceptedThrough: 1 });
    expect(replica().recoveryRequired).toBe(false);
  });

  it("shows a resent live frame once", async () => {
    const frame = live(1, " world");
    useThreadStore.getState().handleCanonicalProgress(frame);
    useThreadStore.getState().handleCanonicalProgress(frame);
    await flushFrames();
    expect(getTestThreadStreaming(THREAD_ID)).toBe("Hello world");
  });

  it("drops a live frame that arrives behind a newer one in the same epoch", async () => {
    const store = useThreadStore.getState();
    store.handleCanonicalProgress(live(1, " world", EPOCH, 5));
    store.handleCanonicalProgress(live(1, " late", EPOCH, 4));
    store.handleCanonicalProgress(live(1, "!", EPOCH, 6));
    await flushFrames();
    expect(getTestThreadStreaming(THREAD_ID)).toBe("Hello world!");
  });

  it.each([
    { name: "an earlier position", frame: () => live(0, " stale") },
    { name: "another epoch", frame: () => live(1, " stale", "00000000-0000-4000-8000-000000000003") },
  ])("drops a live piece sent at $name without asking for recovery", async ({ frame }) => {
    const before = replica();
    useThreadStore.getState().handleCanonicalProgress(frame());
    await flushFrames();
    expect(getTestThreadStreaming(THREAD_ID)).toBe("Hello");
    expect(replica()).toBe(before);
    expect(replica().recoveryRequired).toBe(false);
  });

  it("shows live text once and never asks for recovery through its checkpoint and save", async () => {
    const store = useThreadStore.getState();
    store.handleCanonicalProgress(live(1, " world"));
    store.handleCanonicalProgress(accepted([checkpoint(2, "Hello world")]));
    expect(replica().recoveryRequired).toBe(false);
    store.handleCanonicalProgress(live(2, "!"));
    store.handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch: EPOCH, through: 2,
      revision: { conversationRevision: 2, rosterRevision: 0 },
      events: [envelope(1, { type: "publication.recorded", publicationId: "1", event: textDelta("Hello") }), checkpoint(2, "Hello world")]
        .map((event) => ({ ...event, durableRevision: event.progressPosition.sequence })) });
    await flushFrames();
    expect(getTestThreadStreaming(THREAD_ID)).toBe("Hello world!");
    expect(replica().progress).toMatchObject({ acceptedThrough: 2, savedThrough: 2 });
    expect(replica().recoveryRequired).toBe(false);
  });
});
