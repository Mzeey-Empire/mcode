import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentStopResult } from "@mcode/contracts";
import { useQueueStore } from "@/stores/queueStore";
import { useToastStore } from "@/stores/toastStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, getThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { RpcError } from "@/transport";
import { useQueuedMessageDispatch, useSendNowRoute } from "./useQueuedMessageDispatch";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "queued-message-dispatch-thread";
const HELD_STEER_ID = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_ID = "22222222-2222-4222-8222-222222222222";
const CANCELLED_STOP: AgentStopResult = {
  threadId: THREAD_ID,
  turnExecutionId: "execution-1",
  snapshot: { threadId: THREAD_ID, turnExecutionId: "execution-1", phase: "cancelled" },
  status: "cancelled",
  dispatchState: "dispatched",
};

function queueMessage(content: string): void {
  useQueueStore.getState().enqueue(THREAD_ID, {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
  });
}

function queued(index: number) {
  return useQueueStore.getState().queues[THREAD_ID]![index]!;
}

function queuedContents(): string[] | undefined {
  return useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content);
}

function runTurn(): void {
  useThreadStore.setState({
    records: new Map<string, ThreadRecord>([[THREAD_ID, {
      ...createEmptyThreadRecord(),
      runtimePhase: "running",
      turnExecutionId: "execution-1",
    }]]),
    runningThreadIds: new Set([THREAD_ID]),
  });
}

function queueResend(content: string): void {
  queueMessage(content);
  useQueueStore.getState().setQueuedSteer(THREAD_ID, queued(0).id, { state: "delivery_unknown", steerId: HELD_STEER_ID });
  useQueueStore.getState().requeueAsResend(THREAD_ID, HELD_STEER_ID, REPLACEMENT_ID);
}

describe("useQueuedMessageDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      disposedQueuedMessages: {},
      queueGenerations: {},
      autoDrainSuppressedThreadIds: new Set<string>(),
      toast: null,
      editingThreadId: null,
    });
    useWorkspaceStore.setState({
      activeThreadId: THREAD_ID,
      threads: [createMockThread({ id: THREAD_ID })],
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  });

  it("keeps the queued message when Send now cannot start it", async () => {
    useQueueStore.getState().enqueue(THREAD_ID, {
      content: "final queued follow-up",
      displayContent: "final queued follow-up",
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
      browserCaptureSpillPaths: ["browser-capture-spill/workspace/capture.json"],
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("transport unavailable"),
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(useQueueStore.getState().queues[THREAD_ID]).toEqual([
      expect.objectContaining({
        content: "final queued follow-up",
        browserCaptureSpillPaths: ["browser-capture-spill/workspace/capture.json"],
      }),
    ]);
  });

  it("sends the chosen message at once while the thread is idle", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(1));
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "second queued follow-up" }),
    );
    expect(queuedContents()).toEqual(["first queued follow-up"]);
  });

  it("does not let Send now claim past an in-flight lease", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    const [first, second] = [queued(0), queued(1)];
    let resolveSend!: () => void;
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSend = resolve; }),
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    const sending = result.current.sendNow(first);
    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await act(async () => {
      await result.current.sendNow(second);
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    resolveSend();
    await sending;
  });

  it("clears Stop suppression when Send now sends after a Stop", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(CANCELLED_STOP);
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await useThreadStore.getState().stopAgent(THREAD_ID);
    });
    expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(THREAD_ID)).toBe(true);

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(queuedContents()).toEqual(["second queued follow-up"]);
    expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("neither steers nor sends while a Stop is pending", async () => {
    queueMessage("first queued follow-up");
    let resolveStop!: (result: AgentStopResult) => void;
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStop = resolve; }),
    );
    runTurn();
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    const stopping = useThreadStore.getState().stopAgent(THREAD_ID);
    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(mockTransport.steerTurn).not.toHaveBeenCalled();
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    resolveStop(CANCELLED_STOP);
    await stopping;
  });

  it("Send now while a turn runs steers and never reorders the queue", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    queueMessage("third queued follow-up");
    runTurn();
    const orderDuringSteer: (string[] | undefined)[] = [];
    (mockTransport.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async ({ messageId }: { messageId: string }) => {
        orderDuringSteer.push(queuedContents());
        return { status: "delivered", messageId };
      },
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(1));
    });

    expect(mockTransport.steerTurn).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      content: "second queued follow-up",
    });
    expect(orderDuringSteer).toEqual([
      ["first queued follow-up", "second queued follow-up", "third queued follow-up"],
    ]);
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(queuedContents()).toEqual(["first queued follow-up", "third queued follow-up"]);
  });

  it("keeps a rejected steer queued as an ordinary message and says why", async () => {
    queueMessage("queued follow-up");
    runTurn();
    (mockTransport.steerTurn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RpcError("steer rejected", "steer_rejected", { detail: "turn is compacting" }),
    );
    const show = vi.spyOn(useToastStore.getState(), "show");
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(queued(0)).toEqual(expect.objectContaining({ content: "queued follow-up" }));
    expect(queued(0).steer).toBeUndefined();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed", meta: "turn is compacting" }));
  });

  it("holds a steer with no answer so the dispatcher skips it", async () => {
    queueMessage("unanswered follow-up");
    queueMessage("later follow-up");
    runTurn();
    (mockTransport.steerTurn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("socket closed"));
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(queued(0).steer).toEqual(expect.objectContaining({ state: "steering", turnExecutionId: "execution-1" }));
    expect(useQueueStore.getState().claimNextQueuedMessage(THREAD_ID)?.content).toBe("later follow-up");
  });

  it("holds a delivery-unknown steer out of the dispatcher", async () => {
    queueMessage("uncertain follow-up");
    runTurn();
    (mockTransport.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async ({ messageId }: { messageId: string }) => ({ status: "delivery_unknown", messageId }),
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    const steerId = (mockTransport.steerTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0].messageId;
    expect(queued(0).steer).toEqual({ state: "delivery_unknown", steerId });
    expect(useQueueStore.getState().claimNextQueuedMessage(THREAD_ID)).toBeUndefined();
  });

  it("sends a resend under its replacement id with the steer it replaces", async () => {
    queueResend("resent follow-up");
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: REPLACEMENT_ID,
      resendOfSteerId: HELD_STEER_ID,
      content: "resent follow-up",
    }));
    expect(queuedContents()).toEqual([]);
  });

  it("drops a resend another window already admitted", async () => {
    queueResend("resent follow-up");
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RpcError("resend closed", "steer_resend_closed"),
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(queuedContents()).toEqual([]);
    expect(useQueueStore.getState().inFlightQueuedMessages[THREAD_ID]).toBeUndefined();
    expect(getThreadRecord(useThreadStore.getState().records, THREAD_ID).error).toBeNull();
  });

  it("sends a rejected steer as the next turn when its turn ended meanwhile", async () => {
    vi.useFakeTimers();
    queueMessage("late follow-up");
    runTurn();
    let reject: (error: unknown) => void = () => undefined;
    (mockTransport.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((_, rejectSteer) => { reject = rejectSteer; }),
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));
    let steering: Promise<void> = Promise.resolve();
    act(() => { steering = result.current.sendNow(queued(0)); });

    useThreadStore.setState({
      records: new Map([[THREAD_ID, { ...createEmptyThreadRecord(), runtimePhase: "idle" }]]),
      runningThreadIds: new Set(),
    });
    await act(async () => {
      reject(new RpcError("turn not running", "turn_not_running"));
      await steering;
      await vi.advanceTimersByTimeAsync(400);
    });
    vi.useRealTimers();

    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "late follow-up" }),
    );
  });

  it("neither steers nor sends while the record still names the previous turn", async () => {
    queueMessage("follow-up");
    runTurn();
    useThreadStore.setState((state) => ({
      records: new Map([[THREAD_ID, { ...getThreadRecord(state.records, THREAD_ID), optimisticUserMessageId: "pending" }]]),
    }));
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(mockTransport.steerTurn).not.toHaveBeenCalled();
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
  });

  it("neither steers nor sends while the turn is finalizing", async () => {
    queueMessage("follow-up");
    runTurn();
    useThreadStore.setState((state) => ({
      records: new Map([[THREAD_ID, { ...getThreadRecord(state.records, THREAD_ID), runtimePhase: "finalizing" }]]),
    }));
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.sendNow(queued(0));
    });

    expect(mockTransport.steerTurn).not.toHaveBeenCalled();
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
  });
});

describe("useSendNowRoute", () => {
  beforeEach(() => {
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });
    useQueueStore.setState({ inFlightQueuedMessages: {} });
  });

  it("offers nothing until a stopped turn has finished, then a new send", () => {
    useThreadStore.setState({
      records: new Map([[THREAD_ID, { ...createEmptyThreadRecord(), runtimePhase: "finalizing", turnExecutionId: "exec-stop" }]]),
      pendingStopCounts: { [THREAD_ID]: 1 },
    });
    const { result } = renderHook(() => useSendNowRoute(THREAD_ID));
    expect(result.current).toBe("none");

    act(() => useThreadStore.setState({ pendingStopCounts: {} }));
    expect(result.current).toBe("none");

    act(() => useThreadStore.setState({
      records: new Map([[THREAD_ID, { ...createEmptyThreadRecord(), runtimePhase: "cancelled" }]]),
    }));
    expect(result.current).toBe("send");
  });
});
