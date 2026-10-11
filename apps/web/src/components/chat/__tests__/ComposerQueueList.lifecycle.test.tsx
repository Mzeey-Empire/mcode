import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@mcode/contracts";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { useQueuedMessageDispatch } from "@/features/conversation/composer/queue/useQueuedMessageDispatch";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { getThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { ComposerQueueList } from "../ComposerQueueList";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "composer-queue-lifecycle-thread";

function queueMessage(content: string): void {
  useQueueStore.getState().enqueue(THREAD_ID, {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
    // The composer records the thread's mode on every message.
    orchestrationMode: "standard",
  });
}

function runTurn(): void {
  useThreadStore.setState((state) => ({
    records: new Map([[THREAD_ID, { ...getThreadRecord(state.records, THREAD_ID), runtimePhase: "running", turnExecutionId: "turn-1" }]]),
    runningThreadIds: new Set([THREAD_ID]),
  }));
}

function holdSteer(content: string): QueuedMessage {
  queueMessage(content);
  const held = useQueueStore.getState().queues[THREAD_ID]!.at(-1)!;
  useQueueStore.getState().setQueuedSteer(THREAD_ID, held.id, { state: "delivery_unknown", steerId: "steer-1" });
  return held;
}

function QueueControls({ provider = "cursor", onLoad = () => undefined }: {
  provider?: string;
  onLoad?: (message: QueuedMessage) => void;
}) {
  const { sendNow } = useQueuedMessageDispatch(THREAD_ID);
  return (
    <ComposerQueueList
      threadId={THREAD_ID}
      provider={provider}
      onLoadIntoComposer={onLoad}
      onSendNow={(message) => void sendNow(message)}
    />
  );
}

describe("ComposerQueueList lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    useProviderAvailabilityStore.setState({
      providers: [{ id: "codex", capabilities: [{ name: "turn-steer", support: "supported" }] }] as never,
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  });

  it("shows the remaining FIFO item after a successful completion drain", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    render(<QueueControls />);

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "first queued follow-up" }),
    );
    expect(screen.queryByText("first queued follow-up")).not.toBeInTheDocument();
    expect(screen.getByText("second queued follow-up")).toBeInTheDocument();
  });

  it("keeps the queue visible and paused after a manual stop", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      threadId: THREAD_ID,
      turnExecutionId: "turn-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "turn-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });
    render(<QueueControls />);

    await act(async () => {
      await useThreadStore.getState().stopAgent(THREAD_ID);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("first queued follow-up")).toBeInTheDocument();
    expect(screen.getByText("second queued follow-up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send queued message 1 now" })).toBeInTheDocument();
  });

  it("hides Send now during a turn when the provider cannot steer", () => {
    queueMessage("first queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    render(<QueueControls />);

    expect(screen.queryByRole("button", { name: "Send queued message 1 now" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit queued message 1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove queued message 1" })).toBeEnabled();
  });

  it("sends the chosen row at once when idle and keeps the rest in order", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    queueMessage("third queued follow-up");
    render(<QueueControls />);

    await userEvent.click(screen.getByRole("button", { name: "Send queued message 2 now" }));

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "second queued follow-up" }),
    );
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((m) => m.content)).toEqual([
      "first queued follow-up",
      "third queued follow-up",
    ]);
  });

  it("offers Send again and Remove for a steer whose delivery is unknown", async () => {
    queueMessage("held follow-up");
    const [held] = useQueueStore.getState().queues[THREAD_ID]!;
    useQueueStore.getState().setQueuedSteer(THREAD_ID, held.id, { state: "delivery_unknown", steerId: "steer-1" });
    (mockTransport.settleUnknownSteer as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "requeued",
      replacementMessageId: "replacement-1",
    });
    render(<QueueControls />);

    expect(screen.getByText("Delivery unknown")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit queued message 1" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send queued message 1 again" }));

    expect(mockTransport.settleUnknownSteer).toHaveBeenCalledWith({ messageId: "steer-1", action: "send-again" });
    expect(useQueueStore.getState().queues[THREAD_ID]).toEqual([
      expect.objectContaining({
        id: "replacement-1",
        content: "held follow-up",
        steer: { state: "resend", resendOfSteerId: "steer-1" },
      }),
    ]);
    expect(screen.queryByText("Delivery unknown")).not.toBeInTheDocument();
    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "replacement-1",
      resendOfSteerId: "steer-1",
      content: "held follow-up",
    })));
  });

  it("settles a held steer with the server before removing its row", async () => {
    queueMessage("held follow-up");
    const [held] = useQueueStore.getState().queues[THREAD_ID]!;
    useQueueStore.getState().setQueuedSteer(THREAD_ID, held.id, { state: "delivery_unknown", steerId: "steer-1" });
    const settle = mockTransport.settleUnknownSteer as ReturnType<typeof vi.fn>;
    settle.mockRejectedValueOnce(new Error("socket closed"));
    render(<QueueControls />);

    await userEvent.click(screen.getByRole("button", { name: "Remove queued message 1" }));
    expect(screen.getByText("held follow-up")).toBeInTheDocument();

    settle.mockResolvedValueOnce({ status: "removed" });
    await userEvent.click(screen.getByRole("button", { name: "Remove queued message 1" }));

    expect(settle).toHaveBeenLastCalledWith({ messageId: "steer-1", action: "remove" });
    expect(screen.queryByText("held follow-up")).not.toBeInTheDocument();
  });

  it("offers Send now during a turn only for rows a steer can carry", () => {
    queueMessage("plain follow-up");
    holdSteer("held follow-up");
    useQueueStore.getState().requeueAsResend(THREAD_ID, "steer-1", "replacement-1");
    useQueueStore.getState().enqueue(THREAD_ID, {
      content: "with a file",
      displayContent: "with a file",
      attachments: [{ id: "a", name: "a.png", mimeType: "image/png", sizeBytes: 1 }] as never,
      model: "",
      permissionMode: "full",
    });
    useQueueStore.getState().enqueue(THREAD_ID, {
      content: "proactive", attachments: [], model: "", permissionMode: "full", orchestrationMode: "proactive",
    });
    runTurn();
    render(<QueueControls provider="codex" />);

    expect(screen.getByRole("button", { name: "Send queued message 1 now" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send queued message 2 now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send queued message 3 now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send queued message 4 now" })).not.toBeInTheDocument();
  });

  it("drops a resend on Edit when another window already sent it", async () => {
    holdSteer("held follow-up");
    useQueueStore.getState().requeueAsResend(THREAD_ID, "steer-1", "replacement-1");
    (mockTransport.settleUnknownSteer as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: "closed" });
    const onLoad = vi.fn();
    render(<QueueControls onLoad={onLoad} />);

    await userEvent.click(screen.getByRole("button", { name: "Edit queued message 1" }));

    expect(mockTransport.settleUnknownSteer).toHaveBeenCalledWith({ messageId: "steer-1", action: "remove" });
    expect(onLoad).not.toHaveBeenCalled();
    expect(useQueueStore.getState().queues[THREAD_ID]).toEqual([]);
  });

  it("keeps a resend out of the drain while its Edit is being settled", async () => {
    holdSteer("held follow-up");
    useQueueStore.getState().requeueAsResend(THREAD_ID, "steer-1", "replacement-1");
    let answer: (value: unknown) => void = () => undefined;
    (mockTransport.settleUnknownSteer as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { answer = resolve; }),
    );
    const onLoad = vi.fn();
    render(<QueueControls onLoad={onLoad} />);

    await userEvent.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    expect(useQueueStore.getState().claimNextQueuedMessage(THREAD_ID)).toBeUndefined();
    expect(screen.getByRole("status")).toHaveTextContent("Settling");

    await act(async () => { answer({ status: "removed" }); });

    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ content: "held follow-up" }));
  });
});
