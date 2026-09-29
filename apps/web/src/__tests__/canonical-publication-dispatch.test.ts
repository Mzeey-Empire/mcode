import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AgentEvent, CanonicalAgentEventEnvelope } from "@mcode/contracts";
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
});
