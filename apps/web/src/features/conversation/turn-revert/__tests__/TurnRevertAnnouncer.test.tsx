import { createMockMessage } from "@mcode/contracts/testing";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useThreadStore } from "@/stores/threadStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { TurnRevertAnnouncer } from "../TurnRevertAnnouncer";
import { TurnRevertReceipt } from "../TurnRevertReceipt";
import { acceptTurnRevert } from "../useTurnRevert";

const transport = {
  listSnapshots: vi.mocked(mockTransport.listSnapshots),
  undoTurnRevert: vi.mocked(mockTransport.undoTurnRevert),
};
vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.listSnapshots).mockReset();
  vi.mocked(mockTransport.undoTurnRevert).mockReset();
});

function receipt(id: string, threadId: string, content: string) {
  return createMockMessage({
    id,
    thread_id: threadId,
    role: "system",
    content,
    systemNotice: { kind: "turn-reverted", presentation: "timeline", revertId: `revert-${id}` },
  });
}

beforeEach(() => {
  transport.listSnapshots.mockResolvedValue([]);
  useThreadStore.setState({ records: new Map([["thread-1", createEmptyThreadRecord()], ["thread-2", createEmptyThreadRecord()]]) });
});

describe("TurnRevertAnnouncer", () => {
  it("announces a live receipt for the shown thread", () => {
    render(<TurnRevertAnnouncer threadId="thread-1" />);
    act(() => acceptTurnRevert({ threadId: "thread-1", receipt: receipt("live-1", "thread-1", "Reverted Turn 2 · 3 files") }));
    expect(screen.getByRole("status")).toHaveTextContent("Reverted Turn 2 · 3 files");
  });

  it("stays silent for receipts loaded from history", () => {
    const history = receipt("history-1", "thread-1", "Reverted Turn 1 · 1 file");
    render(<><TurnRevertAnnouncer threadId="thread-1" /><TurnRevertReceipt message={history} /></>);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("ignores a receipt for another thread", () => {
    render(<TurnRevertAnnouncer threadId="thread-1" />);
    act(() => acceptTurnRevert({ threadId: "thread-2", receipt: receipt("other-1", "thread-2", "Reverted Turn 5 · 2 files") }));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("does not replay an earlier announcement when the thread is opened again", () => {
    const { rerender } = render(<TurnRevertAnnouncer threadId="thread-2" />);
    act(() => acceptTurnRevert({ threadId: "thread-2", receipt: receipt("earlier-1", "thread-2", "Reverted Turn 4 · 1 file") }));
    rerender(<TurnRevertAnnouncer threadId="thread-1" />);
    rerender(<TurnRevertAnnouncer threadId="thread-2" />);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
