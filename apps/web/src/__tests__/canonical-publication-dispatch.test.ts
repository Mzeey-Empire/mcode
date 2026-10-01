import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AcceptedCanonicalAgentEventEnvelope, AgentEvent, CanonicalAgentEventEnvelope, CanonicalAgentProgressFrame } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import {
  resetThreadStoreForTests,
  seedThreadRecord,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-publication";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const EPOCH = "00000000-0000-4000-8000-000000000002";
const CURSOR_KEY = `mcode-agent-publication-v2:${THREAD_ID}`;

function publicationEnvelope(publicationId: string, event: Record<string, unknown>): CanonicalAgentEventEnvelope {
  return {
    eventId: `publication:${THREAD_ID}:${publicationId}`,
    routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence: Number(publicationId),
    durableRevision: Number(publicationId),
    serverTimestamps: { acceptedAt: "2026-08-11T12:00:00.000Z", persistedAt: "2026-08-11T12:00:00.000Z" },
    payload: { type: "publication.recorded", publicationId, event },
  };
}

const TOOL_USE: Record<string, unknown> = {
  type: "toolUse",
  threadId: THREAD_ID,
  turnExecutionId: EXECUTION_ID,
  epoch: EPOCH,
  sequence: 8,
  toolCallId: "call-1",
  toolName: "Read",
  toolInput: { path: "/original" },
};

function toolCallCount(): number {
  return readThreadField(THREAD_ID, (record) => record.toolCalls)?.length ?? -1;
}

function progressEnvelope(publicationId: string, event: Record<string, unknown>): AcceptedCanonicalAgentEventEnvelope {
  const { durableRevision: _durableRevision, ...semantic } = publicationEnvelope(publicationId, event);
  return { ...semantic, progressPosition: { epoch: EPOCH, sequence: Number(publicationId) } };
}

function acceptedEnvelope(sequence: number, payload: AcceptedCanonicalAgentEventEnvelope["payload"], itemId?: string): AcceptedCanonicalAgentEventEnvelope {
  return {
    eventId: `accepted:${sequence}`,
    routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, ...(itemId ? { itemId } : {}) },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence: sequence,
    serverTimestamps: { acceptedAt: "2026-08-11T12:00:00.000Z" },
    payload,
    progressPosition: { epoch: EPOCH, sequence },
  };
}

function progressFrame(events: AcceptedCanonicalAgentEventEnvelope[]): CanonicalAgentProgressFrame {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) throw new Error("empty fixture");
  return { phase: "accepted", threadId: THREAD_ID, epoch: EPOCH, from: first.progressPosition.sequence - 1, through: last.progressPosition.sequence, events };
}

describe("canonical publication dispatch", () => {
  beforeEach(() => {
    sessionStorage.removeItem(CURSOR_KEY);
    clearRecordCache();
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });
    useThreadStore.setState({
      records: seedThreadRecord(THREAD_ID, { runtimePhase: "running", turnExecutionId: EXECUTION_ID }),
      runningThreadIds: new Set([THREAD_ID]),
    });
    vi.clearAllMocks();
  });

  it("applies a recorded publication through the agent event path with its publication identity", () => {
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [publicationEnvelope("1", TOOL_USE)]);
    expect(toolCallCount()).toBe(1);
  });

  it("applies a publication once when the agent.event copy also arrives", () => {
    const envelope = publicationEnvelope("1", TOOL_USE);
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [envelope]);
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [envelope]);
    useThreadStore.getState().handleAgentEvent({ ...TOOL_USE, publicationId: "1" } as AgentEvent);
    expect(toolCallCount()).toBe(1);
  });

  it("renders accepted text, a tool and completion before writes and never replays saved effects", () => {
    const events = [
      progressEnvelope("1", TOOL_USE),
      progressEnvelope("2", { type: "textDelta", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, delta: "Visible before saving", isFinalResponse: true }),
      progressEnvelope("3", { type: "ended", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, reason: "completed", outcome: "completed" }),
    ];
    useThreadStore.getState().handleCanonicalProgress(progressFrame(events));
    const record = useThreadStore.getState().records.get(THREAD_ID);
    expect(record?.messages.filter((message) => message.content === "Visible before saving")).toHaveLength(1);
    expect(record?.runtimePhase).toBe("completed");
    expect(record?.canonicalAgent.revision.conversationRevision).toBe(0);
    expect(toolCallCount()).toBe(1);
    const dispatch = vi.spyOn(useThreadStore.getState(), "handleAgentEvent");
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch: EPOCH, through: 3,
      revision: { conversationRevision: 3, rosterRevision: 0 }, events: events.map((event) => ({ ...event, durableRevision: event.progressPosition.sequence })) });
    useThreadStore.getState().handleCanonicalProgress(progressFrame(events));
    expect(dispatch).not.toHaveBeenCalled();
    expect(toolCallCount()).toBe(1);
    expect(useThreadStore.getState().records.get(THREAD_ID)?.canonicalAgent.revision.conversationRevision).toBe(3);
    dispatch.mockRestore();
  });

  it("yields large publication replays to the next animation frame", () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const events = Array.from({ length: 33 }, (_, index) =>
      progressEnvelope(String(index + 1), { ...TOOL_USE, toolCallId: `call-${index + 1}` }));

    useThreadStore.getState().handleCanonicalProgress(progressFrame(events));

    expect(toolCallCount()).toBe(0);
    expect(frames).toHaveLength(1);
    while (frames.length > 0) {
      frames.shift()?.(performance.now());
    }
    expect(toolCallCount()).toBe(33);
    raf.mockRestore();
    cancel.mockRestore();
  });

  it("skips duplicate legacy tool projection during canonical bursts when items already exist", () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const events = Array.from({ length: 33 }, (_, index) => {
      const sequence = index * 2 + 1;
      const toolCallId = `call-${index + 1}`;
      const itemId = `toolCall:${toolCallId}`;
      return [
        acceptedEnvelope(sequence, {
          type: "item.recorded",
          item: {
            id: itemId,
            threadId: THREAD_ID,
            turnId: TURN_ID,
            kind: "tool-call",
            providerIdentities: [],
            payload: { projection: "codexChildToolCall", nativeItemId: toolCallId, toolName: "Read", toolInput: { path: "/file" } },
            createdAt: "2026-08-11T12:00:00.000Z",
            updatedAt: "2026-08-11T12:00:00.000Z",
          },
        }, itemId),
        progressEnvelope(String(sequence + 1), { ...TOOL_USE, toolCallId }),
      ];
    }).flat();

    useThreadStore.getState().handleCanonicalProgress(progressFrame(events));

    while (frames.length > 0) {
      frames.shift()?.(performance.now());
    }
    expect(toolCallCount()).toBe(0);
    expect(Object.keys(useThreadStore.getState().records.get(THREAD_ID)!.canonicalAgent.state.items)).toHaveLength(33);
    raf.mockRestore();
    cancel.mockRestore();
  });

  it("repairs an earlier publication without a later legacy cursor suppressing it", () => {
    useThreadStore.getState().handleAgentEvent({ ...TOOL_USE, toolCallId: "call-2", publicationId: "2" } as AgentEvent);
    useThreadStore.getState().handleCanonicalProgress(progressFrame([progressEnvelope("1", TOOL_USE), progressEnvelope("2", { ...TOOL_USE, toolCallId: "call-2" })]));
    expect(toolCallCount()).toBe(2);
  });

  it("fences concurrent pushes until recovery is installed, then releases each effect once", () => {
    const token = useThreadStore.getState().beginCanonicalRecovery([THREAD_ID]);
    const frame = progressFrame([progressEnvelope("1", TOOL_USE)]);
    useThreadStore.getState().handleCanonicalProgress(frame);
    expect(toolCallCount()).toBe(0);
    useThreadStore.getState().applyCanonicalReconnectRecoveries([{ phase: "recovery", threadId: THREAD_ID, epoch: EPOCH,
      acceptedThrough: 0, savedThrough: 0, retained: [], loss: "none",
      durable: { mode: "delta", threadId: THREAD_ID, from: { conversationRevision: 0, rosterRevision: 0 }, through: { conversationRevision: 0, rosterRevision: 0 }, events: [] } }]);
    useThreadStore.getState().finishCanonicalRecovery(token);
    useThreadStore.getState().handleCanonicalProgress(frame);
    expect(toolCallCount()).toBe(1);
  });
});
