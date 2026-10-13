import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, TurnRevertResult } from "@mcode/contracts";
import { createMockMessage } from "@/__tests__/mocks/transport";
import { useThreadStore } from "@/stores/threadStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { TurnRevertReceipt } from "../TurnRevertReceipt";

const transport = vi.hoisted(() => ({
  undoTurnRevert: vi.fn(),
  listSnapshots: vi.fn(),
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

const revertReceipt = createMockMessage({
  id: "receipt-1",
  thread_id: "thread-1",
  role: "system",
  content: "Reverted Turn 3 · 7 files",
  systemNotice: { kind: "turn-reverted", presentation: "timeline", revertId: "revert-1" },
});

const undoReceipt = createMockMessage({
  id: "receipt-2",
  thread_id: "thread-1",
  role: "system",
  content: "Undid revert · Turn 3",
  systemNotice: { kind: "turn-revert-undone", presentation: "timeline", revertId: "revert-2", undoesRevertId: "revert-1" },
});

const undone: TurnRevertResult = {
  status: "reverted",
  receipt: undoReceipt,
  revert: {
    id: "revert-2",
    threadId: "thread-1",
    targetMessageId: "msg-1",
    fromMessageId: "msg-1",
    kind: "undo",
    path: null,
    undoesRevertId: "revert-1",
    undoneByRevertId: null,
    files: [],
    receiptMessageId: "receipt-2",
    createdAt: "2026-10-13T10:01:00.000Z",
  },
};

function seedMessages(messages: Message[]) {
  useThreadStore.setState({ records: new Map([["thread-1", { ...createEmptyThreadRecord(), messages }]]) });
}

function Timeline() {
  const messages = useThreadStore((s) => s.records.get("thread-1")?.messages ?? []);
  return <>{messages.map((message) => <TurnRevertReceipt key={message.id} message={message} />)}</>;
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.listSnapshots.mockResolvedValue([]);
  seedMessages([revertReceipt]);
});

describe("TurnRevertReceipt", () => {
  it("splits the receipt into a label and a detail with an Undo button", () => {
    render(<TurnRevertReceipt message={revertReceipt} />);
    expect(screen.getByText("Reverted Turn 3")).toBeInTheDocument();
    expect(screen.getByText("7 files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("writes the undo receipt and removes Undo", async () => {
    transport.undoTurnRevert.mockResolvedValue(undone);
    render(<Timeline />);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undid revert")).toBeInTheDocument();
    expect(screen.getByText("Turn 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(transport.undoTurnRevert).toHaveBeenCalledWith("thread-1", "revert-1", expect.any(String));
  });

  it("removes Undo after a successful undo even when the timeline is paged back", async () => {
    transport.undoTurnRevert.mockResolvedValue(undone);
    useThreadStore.setState({ records: new Map([["thread-1", { ...createEmptyThreadRecord(), messages: [revertReceipt], hasNewerMessages: true }]]) });
    render(<Timeline />);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument());
    expect(screen.queryByText("Undid revert")).not.toBeInTheDocument();
  });

  it("keeps Undo when the only notice naming the revert is an interrupted undo", () => {
    const interruptedUndo = createMockMessage({
      id: "receipt-3",
      thread_id: "thread-1",
      role: "system",
      content: "Undo of Turn 3 was interrupted. Files were put back.",
      systemNotice: { kind: "turn-revert-interrupted", presentation: "timeline", revertId: "revert-3", undoesRevertId: "revert-1" },
    });
    seedMessages([revertReceipt, interruptedUndo]);
    render(<Timeline />);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("has no Undo once a persisted undo receipt names the revert", () => {
    seedMessages([revertReceipt, undoReceipt]);
    render(<Timeline />);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("disables Undo when files changed since the revert", async () => {
    transport.undoTurnRevert.mockResolvedValue({ status: "stale", preview: { status: "nothing_to_revert" } });
    render(<TurnRevertReceipt message={revertReceipt} />);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    const button = await screen.findByRole("button", { name: "Undo", description: "Files changed since the revert" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(transport.undoTurnRevert).toHaveBeenCalledOnce();
  });

  it("disables Undo when its recovery material expired", async () => {
    transport.undoTurnRevert.mockResolvedValue({ status: "unavailable", reason: "recovery_expired" });
    render(<TurnRevertReceipt message={revertReceipt} />);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: "Undo", description: "Undo is no longer available" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  it("renders an interrupted revert as one sentence without Undo", () => {
    const interrupted = createMockMessage({
      thread_id: "thread-1",
      role: "system",
      content: "Revert of Turn 3 was interrupted. Files were put back.",
      systemNotice: { kind: "turn-revert-interrupted", presentation: "timeline", revertId: "revert-9" },
    });
    render(<TurnRevertReceipt message={interrupted} />);
    expect(screen.getByText("Revert of Turn 3 was interrupted. Files were put back.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("leaves a receipt pushed mid-load to the load, so the load still commits", async () => {
    const { acceptTurnRevert } = await import("../useTurnRevert");
    useThreadStore.setState({ records: new Map([["thread-1", { ...createEmptyThreadRecord(), loading: true }]]) });
    acceptTurnRevert({ threadId: "thread-1", receipt: undoReceipt });
    expect(useThreadStore.getState().records.get("thread-1")?.messages).toEqual([]);
  });

  it("shows a receipt another window committed once, through the push", async () => {
    const { acceptTurnRevert } = await import("../useTurnRevert");
    render(<Timeline />);
    act(() => {
      acceptTurnRevert({ threadId: "thread-1", receipt: undoReceipt });
      acceptTurnRevert({ threadId: "thread-1", receipt: undoReceipt });
    });
    await waitFor(() => expect(screen.getAllByText("Undid revert")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});
