import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { useFileRevertInset } from "../useFileRevertInset";

const transport = vi.hoisted(() => ({ previewTurnRevert: vi.fn(), applyTurnRevert: vi.fn(), listSnapshots: vi.fn() }));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

function Header() {
  const revert = useFileRevertInset("thread-1", "turn:m1", { messageId: "m1", range: { from: 1, to: 1 } });
  const { onRevert } = revert.actionProps("a.ts");
  return (
    <>
      <button type="button" onClick={onRevert}>Revert file</button>
      {revert.inset("a.ts")}
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.listSnapshots.mockResolvedValue([]);
  transport.previewTurnRevert.mockResolvedValue({
    status: "ready", previewToken: "token-1", skipped: [], unattributedChangeCount: 0,
    files: [{ path: "a.ts", action: "restore", state: "clean", binary: false }],
  });
  useThreadStore.setState({ records: new Map([["thread-1", createEmptyThreadRecord()]]) });
});

describe("useFileRevertInset", () => {
  it("returns focus to the Revert file button when the confirm closes", async () => {
    render(<Header />);
    await userEvent.click(screen.getByRole("button", { name: "Revert file" }));
    await screen.findByRole("button", { name: "Cancel" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Revert file" })).toHaveFocus();
  });

  it("leaves focus alone when the user moved it while the revert was applying", async () => {
    let finish: (value: unknown) => void = () => {};
    transport.applyTurnRevert.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<><Header /><input aria-label="Elsewhere" /></>);
    await userEvent.click(screen.getByRole("button", { name: "Revert file" }));
    await userEvent.click(await screen.findByRole("button", { name: "Revert" }));
    await userEvent.click(screen.getByLabelText("Elsewhere"));
    finish({
      status: "reverted",
      receipt: { id: "r", thread_id: "thread-1", role: "system", content: "Reverted a.ts · Turn 1", timestamp: "2026-10-14T10:00:00.000Z" },
      revert: { id: "rv", threadId: "thread-1", targetMessageId: "m1", fromMessageId: null, kind: "file", path: "a.ts", undoesRevertId: null, undoneByRevertId: null, files: [], receiptMessageId: "r", createdAt: "2026-10-14T10:00:00.000Z" },
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("Elsewhere")).toHaveFocus();
  });
});
