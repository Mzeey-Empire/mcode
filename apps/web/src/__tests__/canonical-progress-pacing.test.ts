// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptedCanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type { CanonicalAgentProgressFrame } from "@mcode/contracts/models/canonical-agent-progress";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { getThreadRuntimePhase } from "@/stores/thread-lifecycle";
import { readThreadField, resetThreadStoreForTests, seedThreadRecord } from "@/stores/thread-store-test-utils";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-paced";
const TURN_ID = "turn-paced";
const EXECUTION_ID = "00000000-0000-4000-8000-00000000000a";
const EPOCH = "runtime-1:turn";
const NOW = "2026-11-02T13:00:00.000Z";
const TOOL_CALLS = 20;
const TEXT_DELTAS = 300;

let sequence = 0;
const animationFrames = new Map<number, FrameRequestCallback>();

function envelope(payload: AcceptedCanonicalAgentEventEnvelope["payload"]): AcceptedCanonicalAgentEventEnvelope {
  sequence += 1;
  return {
    eventId: `event-${sequence}`,
    routing: {
      threadId: THREAD_ID,
      executionId: EXECUTION_ID,
      ...(payload.type === "thread.recorded" ? {} : { turnId: TURN_ID }),
    },
    sourceProviderId: "claude",
    sourceIdentities: [],
    acceptedSequence: sequence,
    serverTimestamps: { acceptedAt: NOW },
    progressPosition: { epoch: EPOCH, sequence },
    payload,
  };
}

function publication(event: Record<string, unknown>): AcceptedCanonicalAgentEventEnvelope {
  return envelope({ type: "publication.recorded", publicationId: String(sequence + 1),
    event: { threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, ...event } });
}

/** One turn as the server streams it: thousands of small batches, many tools, then a provider failure. */
function streamedTurn(): AcceptedCanonicalAgentEventEnvelope[][] {
  const start = [
    envelope({ type: "thread.recorded", thread: { id: THREAD_ID, workspaceId: "workspace-1", rootThreadId: THREAD_ID,
      providerId: "claude", providerIdentities: [], activityState: "Active", conversationRevision: 1, rosterRevision: 0,
      createdAt: NOW, updatedAt: NOW } }),
    envelope({ type: "turn.created", turn: { id: TURN_ID, threadId: THREAD_ID, executionId: EXECUTION_ID,
      status: "Pending", trigger: { kind: "user" }, permissionMode: "full", approvalReviewMode: "manual",
      approvalReviewReason: "manual-requested", attemptOf: null, providerIdentities: [], startedAt: null,
      providerStartedAt: null, ending: null, endedAt: null, createdAt: NOW, updatedAt: NOW } }),
    envelope({ type: "turn.started", startedAt: NOW }),
    publication({ type: "turnStarted" }),
  ];
  const tools = Array.from({ length: TOOL_CALLS }, (_, index) => [publication({ type: "toolUse",
    toolCallId: `call-${index}`, toolName: "Read", toolInput: { path: `/file-${index}` } })]);
  const text = Array.from({ length: TEXT_DELTAS }, () => [publication({ type: "textDelta", delta: "word ", isFinalResponse: false })]);
  const failure = [
    envelope({ type: "turn.errored", endedAt: NOW, error: "Provider failed",
      failure: { kind: "fatal", provider: "claude", message: "Provider failed" } }),
    publication({ type: "error", error: "Provider failed", failure: { kind: "fatal" } }),
  ];
  return [start, ...tools, ...text, failure];
}

/** Delivers each batch the way the server publishes it: an accepted frame, then its saved frame. */
function deliver(batches: AcceptedCanonicalAgentEventEnvelope[][]): void {
  for (const events of batches) {
    const first = events[0];
    const last = events.at(-1);
    if (!first || !last) throw new Error("Empty batch fixture");
    const through = last.progressPosition.sequence;
    const accepted: CanonicalAgentProgressFrame = { phase: "accepted", threadId: THREAD_ID, epoch: EPOCH,
      from: first.progressPosition.sequence - 1, through, events };
    const saved: CanonicalAgentProgressFrame = { phase: "saved", threadId: THREAD_ID, epoch: EPOCH, through,
      revision: { conversationRevision: through, rosterRevision: 0 },
      events: events.map((event) => ({ ...event, durableRevision: event.acceptedSequence })) };
    useThreadStore.getState().handleCanonicalProgress(accepted);
    useThreadStore.getState().handleCanonicalProgress(saved);
  }
}

function runAnimationFrame(): void {
  const pending = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of pending) callback(performance.now());
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const phase = () => readThreadField(THREAD_ID, (record) => getThreadRuntimePhase(THREAD_ID, record));

describe("canonical progress pacing", () => {
  beforeEach(() => {
    sequence = 0;
    animationFrames.clear();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame += 1;
      animationFrames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { animationFrames.delete(id); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.parse(NOW));
    clearRecordCache();
    resetThreadStoreForTests();
    useThreadStore.setState({
      currentThreadId: THREAD_ID,
      records: seedThreadRecord(THREAD_ID, { runtimePhase: "running", turnExecutionId: EXECUTION_ID }),
      runningThreadIds: new Set([THREAD_ID]),
    });
  });

  afterEach(() => {
    setVisibility("visible");
    vi.runOnlyPendingTimers();
    while (animationFrames.size > 0) runAnimationFrame();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("settles a turn that ended while the window was hidden, without waiting for a painted frame", () => {
    setVisibility("hidden");
    deliver(streamedTurn());

    vi.runOnlyPendingTimers();

    expect(phase()).toBe("errored");
    expect(isThreadExecuting(THREAD_ID)).toBe(false);
  });

  it("drains a streamed backlog in one painted frame when its work fits the frame", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    deliver(streamedTurn());
    expect(phase()).toBe("running");

    runAnimationFrame();

    expect(phase()).toBe("errored");
    expect(isThreadExecuting(THREAD_ID)).toBe(false);
  });
});
