// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createAgentModelState, reduceAgentEventBatch, type AcceptedCanonicalAgentEventEnvelope, type AgentItem, type CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import { useThreadStore } from "@/stores/threadStore";
import { resetThreadStoreForTests, seedThreadRecord } from "@/stores/thread-store-test-utils";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { prepareLiveNarrative, projectLiveNarrativeItems } from "@/features/conversation/narrative/live-narrative-timeline";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-reconnect";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const EPOCH = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-08-11T12:00:00.000Z";

const line = (n: number) => `${n}: Sentence about ${n}.\n`;
const linesThrough = (n: number) => Array.from({ length: n }, (_, index) => line(index + 1)).join("");

const ANSWER_ID = `assistant-response-text:${EXECUTION_ID}`;

function answerItem(content: string): AgentItem {
  return {
    id: ANSWER_ID, threadId: THREAD_ID, turnId: TURN_ID, kind: "message",
    providerIdentities: [], createdAt: NOW, updatedAt: NOW,
    payload: { projection: "assistantText", content, isStreaming: true },
  };
}

function durableEnvelope(sequence: number, payload: CanonicalAgentEventEnvelope["payload"]): CanonicalAgentEventEnvelope {
  return {
    eventId: `event-${sequence}`,
    routing: {
      threadId: THREAD_ID,
      ...(payload.type === "thread.recorded" ? {} : { turnId: TURN_ID }),
      executionId: EXECUTION_ID,
      ...(payload.type === "item.recorded" ? { itemId: payload.item.id } : {}),
      ...(payload.type === "item.content-appended" ? { itemId: ANSWER_ID } : {}),
    },
    sourceProviderId: "claude",
    sourceIdentities: [],
    acceptedSequence: sequence,
    durableRevision: sequence,
    serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
    payload,
  };
}

const RUNNING_TURN = [
  durableEnvelope(1, { type: "thread.recorded", thread: { id: THREAD_ID, workspaceId: "workspace", rootThreadId: THREAD_ID,
    providerId: "claude", providerIdentities: [], activityState: "Active", conversationRevision: 1, rosterRevision: 0,
    createdAt: NOW, updatedAt: NOW } }),
  durableEnvelope(2, { type: "turn.created", turn: { id: TURN_ID, threadId: THREAD_ID, status: "Pending", trigger: { kind: "user" },
    permissionMode: "full", approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null, providerIdentities: [],
    startedAt: null, providerStartedAt: null, ending: null, endedAt: null, createdAt: NOW, updatedAt: NOW } }),
  durableEnvelope(3, { type: "turn.started", startedAt: NOW }),
];

let progressSequence = 0;

function acceptedEnvelope(payload: AcceptedCanonicalAgentEventEnvelope["payload"]): AcceptedCanonicalAgentEventEnvelope {
  progressSequence += 1;
  const { durableRevision: _durableRevision, ...semantic } = durableEnvelope(100 + progressSequence, payload as CanonicalAgentEventEnvelope["payload"]);
  return { ...semantic, progressPosition: { epoch: EPOCH, sequence: progressSequence } };
}

type AnswerShape = "replace" | "append";

/**
 * Mirrors the server: the answer item, then the undecided Claude delta that carries no answer flag.
 * The answer is either the whole text so far or, after the first line, an append of the new line.
 */
function streamLine(n: number, shape: AnswerShape): AcceptedCanonicalAgentEventEnvelope[] {
  const item = shape === "append" && n > 1
    ? acceptedEnvelope({ type: "item.content-appended", offset: linesThrough(n - 1).length, text: line(n), updatedAt: NOW })
    : acceptedEnvelope({ type: "item.recorded", item: answerItem(linesThrough(n)) });
  const delta = acceptedEnvelope({ type: "publication.recorded", publicationId: String(progressSequence + 1),
    event: { type: "textDelta", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, delta: line(n) } });
  return [item, delta];
}

function deliver(events: AcceptedCanonicalAgentEventEnvelope[]): void {
  useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch: EPOCH,
    from: events[0]!.progressPosition.sequence - 1, through: events.at(-1)!.progressPosition.sequence, events });
}

const frames: FrameRequestCallback[] = [];
function drainFrames(): void {
  while (frames.length > 0) frames.shift()!(performance.now());
}

function liveTimeline() {
  const record = useThreadStore.getState().records.get(THREAD_ID)!;
  const preparation = prepareLiveNarrative({ toolCalls: record.toolCalls, hooks: record.hooks,
    thoughtSegments: record.thoughtSegments, streamingText: record.streaming, isAgentRunning: true });
  return projectLiveNarrativeItems(preparation, { hooks: record.hooks, streamingText: record.streaming, isAgentRunning: true })
    .map((item) => ("text" in item ? { type: item.type, text: item.text } : { type: item.type }));
}

const SESSION_START_HOOK: AgentItem = {
  id: "hook:session-start", threadId: THREAD_ID, turnId: TURN_ID, kind: "system",
  providerIdentities: [], createdAt: NOW, updatedAt: NOW,
  payload: { projection: "hook", record: { id: "session-start", message_id: "message-1", hook_name: "SessionStart:startup", tool_name: null,
    phase: "stop", payload: "{}", duration_ms: 42, did_block: false, started_at: NOW, ended_at: NOW, sort_order: 0 } },
};

/** Lines `from..through` are accepted by the server while the client is away; the recovery hands back the cursor. */
function reconnectAfterMissing(from: number, through: number, narrative: readonly AgentItem[], shape: AnswerShape): void {
  for (let n = from; n <= through; n += 1) streamLine(n, shape);
  const items = [...narrative, answerItem(linesThrough(through))];
  const base = 100 + progressSequence - items.length;
  const recorded = items.map((item, index) => durableEnvelope(base + index + 1, { type: "item.recorded", item }));
  const reduced = reduceAgentEventBatch(createAgentModelState(), [...RUNNING_TURN, ...recorded]);
  if (reduced.outcome !== "applied") throw new Error(`snapshot fixture did not apply: ${reduced.outcome}`);
  useThreadStore.getState().applyCanonicalReconnectRecoveries([{ phase: "recovery", threadId: THREAD_ID, epoch: EPOCH,
    acceptedThrough: progressSequence, savedThrough: progressSequence, retained: [], loss: "none",
    durable: { mode: "snapshot", threadId: THREAD_ID, snapshot: { revision: { conversationRevision: 100 + progressSequence, rosterRevision: 0 }, state: reduced.state } } }]);
  drainFrames();
}

describe("canonical reconnect answer text", () => {
  beforeEach(() => {
    progressSequence = 0;
    clearRecordCache();
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });
    useThreadStore.setState({
      records: seedThreadRecord(THREAD_ID, { runtimePhase: "running", turnExecutionId: EXECUTION_ID,
        hooks: [{ hookName: "SessionStart:startup", hookType: "stop", status: "completed", outputLines: [], fullOutput: [], startedAt: 1 }] }),
      runningThreadIds: new Set([THREAD_ID]),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, RUNNING_TURN);
  });

  it.each([
    { server: "no narrative items", narrative: [], shape: "replace" as const },
    { server: "a hook but no narration segments", narrative: [SESSION_START_HOOK], shape: "replace" as const },
    { server: "no narrative items", narrative: [], shape: "append" as const },
    { server: "a hook but no narration segments", narrative: [SESSION_START_HOOK], shape: "append" as const },
  ])("keeps the whole answer across a reconnect when the server has $server and streams by $shape", ({ narrative, shape }) => {
    for (let n = 1; n <= 37; n += 1) {
      deliver(streamLine(n, shape));
      drainFrames();
    }
    expect(liveTimeline()).toEqual([{ type: "hook" }, { type: "delta", text: linesThrough(37) }]);

    reconnectAfterMissing(38, 58, narrative, shape);
    expect(liveTimeline()).toEqual([{ type: "hook" }, { type: "delta", text: linesThrough(58) }]);

    for (let n = 59; n <= 60; n += 1) {
      deliver(streamLine(n, shape));
      drainFrames();
    }
    expect(liveTimeline()).toEqual([{ type: "hook" }, { type: "delta", text: linesThrough(60) }]);
  });

  it("resyncs the streamed answer from a saved batch that only appends to it", () => {
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [
      durableEnvelope(4, { type: "item.recorded", item: answerItem(linesThrough(1)) }),
    ]);
    drainFrames();
    expect(liveTimeline()).toEqual([{ type: "hook" }, { type: "delta", text: linesThrough(1) }]);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [
      durableEnvelope(5, { type: "item.content-appended", offset: linesThrough(1).length, text: line(2), updatedAt: NOW }),
    ]);
    drainFrames();

    expect(liveTimeline()).toEqual([{ type: "hook" }, { type: "delta", text: linesThrough(2) }]);
  });
});
