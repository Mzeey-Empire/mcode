import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "followup-runtime";
const OTHER_THREAD_ID = "other-runtime";

function record() {
  return useThreadStore.getState().records.get(THREAD_ID);
}

function completeFirstTurn(): void {
  const handle = useThreadStore.getState().handleAgentEvent;
  handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "first" });
  handle({ type: "textDelta", threadId: THREAD_ID, turnExecutionId: "first", delta: "First reply" });
  handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "first", outcome: "completed" });
  expect(record()?.runtimePhase).toBe("completed");
}

describe("follow-up runtime ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(mockTransport.sendMessage).mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      activeThreadId: THREAD_ID,
      threads: [createMockThread({ id: THREAD_ID }), createMockThread({ id: OTHER_THREAD_ID })],
    });
    resetThreadStoreForTests({
      currentThreadId: THREAD_ID,
      runningThreadIds: new Set(),
      records: new Map([
        [THREAD_ID, createEmptyThreadRecord()],
        [OTHER_THREAD_ID, createEmptyThreadRecord()],
      ]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])("completes a sent follow-up without file-effect metadata, background=%s", async (background) => {
    completeFirstTurn();
    expect(await useThreadStore.getState().sendMessage(THREAD_ID, "Second prompt")).toBe(true);
    expect(record()?.turnExecutionId).toBeNull();
    if (background) {
      useThreadStore.setState({ currentThreadId: OTHER_THREAD_ID });
      useWorkspaceStore.setState({ activeThreadId: OTHER_THREAD_ID });
    }

    const handle = useThreadStore.getState().handleAgentEvent;
    handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "second" });
    expect(record()?.turnExecutionId).toBe("second");
    handle({ type: "textDelta", threadId: THREAD_ID, turnExecutionId: "second", delta: "Second reply" });
    handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "second", outcome: "completed" });

    expect(record()?.runtimePhase).toBe("completed");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
    expect(record()?.messages.map((message) => message.content)).toContain("Second reply");
    expect(record()?.messages.map((message) => message.content)).toContain("First reply");
    expect(useThreadStore.getState().records.get(OTHER_THREAD_ID)?.runtimePhase).toBe("idle");
  });

  it("retains the follow-up response on a duplicate start and ignores the previous turn's completion", async () => {
    completeFirstTurn();
    await useThreadStore.getState().sendMessage(THREAD_ID, "Second prompt");
    const handle = useThreadStore.getState().handleAgentEvent;
    handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "second" });
    handle({ type: "textDelta", threadId: THREAD_ID, turnExecutionId: "second", delta: "Kept reply" });
    handle({ type: "contextEstimate", threadId: THREAD_ID, turnExecutionId: "second", tokensIn: 20 });
    const responseKey = record()?.currentTurnResponseKey;
    handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "second" });
    handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "first", outcome: "completed" });

    expect(record()?.turnExecutionId).toBe("second");
    expect(record()?.runtimePhase).toBe("running");
    expect(record()?.currentTurnResponseKey).toBe(responseKey);
    expect(record()?.streaming).toBe("Kept reply");
    handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "second", outcome: "completed" });
    expect(record()?.runtimePhase).toBe("completed");
  });
});
