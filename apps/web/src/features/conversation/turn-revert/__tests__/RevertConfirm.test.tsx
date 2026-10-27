import { createMockMessage } from "@mcode/contracts/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RevertFilePlan, TurnRevertPreview, TurnRevertResult } from "@mcode/contracts";

import { useThreadStore } from "@/stores/threadStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { TurnRevertBarConfirm } from "../TurnRevertBarConfirm";

const transport = vi.hoisted(() => ({
  previewTurnRevert: vi.fn(),
  applyTurnRevert: vi.fn(),
  listSnapshots: vi.fn(),
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

type ReadyPreview = Extract<TurnRevertPreview, { status: "ready" }>;

function file(path: string, overrides: Partial<RevertFilePlan> = {}): RevertFilePlan {
  return { path, action: "restore", state: "clean", binary: false, ...overrides };
}

function ready(files: RevertFilePlan[], overrides: Partial<ReadyPreview> = {}): ReadyPreview {
  return { status: "ready", previewToken: "token-1", files, skipped: [], unattributedChangeCount: 0, ...overrides };
}

const receipt = createMockMessage({
  id: "receipt-1",
  thread_id: "thread-1",
  role: "system",
  content: "Reverted Turn 3 · 2 files",
  systemNotice: { kind: "turn-reverted", presentation: "timeline", revertId: "revert-1" },
});

const reverted: TurnRevertResult = {
  status: "reverted",
  receipt,
  revert: {
    id: "revert-1",
    threadId: "thread-1",
    targetMessageId: "msg-1",
    fromMessageId: "msg-1",
    kind: "turn",
    path: null,
    undoesRevertId: null,
    undoneByRevertId: null,
    files: [],
    receiptMessageId: "receipt-1",
    createdAt: "2026-10-13T10:00:00.000Z",
  },
};

function renderConfirm(onClose = vi.fn()) {
  render(<TurnRevertBarConfirm threadId="thread-1" messageId="msg-1" onClose={onClose} />);
  return onClose;
}

async function showPreview(preview: TurnRevertPreview) {
  transport.previewTurnRevert.mockResolvedValue(preview);
  const onClose = renderConfirm();
  await waitFor(() => expect(screen.queryByText("Checking files…")).not.toBeInTheDocument());
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.listSnapshots.mockResolvedValue([]);
  useThreadStore.setState({ records: new Map([["thread-1", createEmptyThreadRecord()]]) });
});

describe("RevertConfirm body", () => {
  it("keeps Revert disabled until the preview arrives, with focus on Cancel", () => {
    transport.previewTurnRevert.mockReturnValue(new Promise(() => {}));
    renderConfirm();
    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("names the one file a later turn edited", async () => {
    await showPreview(ready([file("src/ProjectTree.tsx", { state: "changed_later", changedBy: "later_turn" }), file("a.ts")]));
    expect(screen.getByText("Revert 2 files to before this turn?")).toBeInTheDocument();
    expect(screen.getByText("ProjectTree.tsx was edited by a later turn. Reverting removes those edits too.")).toBeInTheDocument();
  });

  it("counts the other files when several were edited later", async () => {
    await showPreview(ready([
      file("src/ProjectTree.tsx", { state: "changed_later", changedBy: "later_turn" }),
      file("b.ts", { state: "changed_later", changedBy: "outside" }),
      file("c.ts", { state: "changed_later", changedBy: "later_turn" }),
    ]));
    expect(screen.getByText("ProjectTree.tsx and 2 other files were edited later. Reverting removes those edits too.")).toBeInTheDocument();
  });

  it("says a file changed after the turn when the edit came from outside", async () => {
    await showPreview(ready([file("src/ProjectTree.tsx", { state: "changed_later", changedBy: "outside" })]));
    expect(screen.getByText("Revert 1 file to before this turn?")).toBeInTheDocument();
    expect(screen.getByText("ProjectTree.tsx changed after this turn. Reverting removes those changes too.")).toBeInTheDocument();
  });

  it("has no body for a clean preview and adds the command note when changes were unattributed", async () => {
    await showPreview(ready([file("a.ts"), file("b.ts", { state: "already_reverted" })], { unattributedChangeCount: 2 }));
    expect(screen.getByText("Revert 1 file to before this turn?")).toBeInTheDocument();
    expect(screen.queryByText(/Reverting removes/)).not.toBeInTheDocument();
    expect(screen.getByText("Files changed by commands in this turn are not reverted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
  });

  it("offers only Close when the server says the turn is busy", async () => {
    await showPreview({ status: "busy", reason: "turn_running" });
    expect(screen.getByText("Wait for the turn to finish")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revert" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("closes on Esc", async () => {
    const onClose = await showPreview(ready([file("a.ts")]));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("RevertConfirm outcomes", () => {
  async function applyWith(result: TurnRevertResult) {
    const onClose = await showPreview(ready([file("src/ProjectTree.tsx")]));
    transport.applyTurnRevert.mockResolvedValue(result);
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    return onClose;
  }

  it("offers Retry when a failed revert left files unchanged", async () => {
    await applyWith({ status: "failed", outcome: "unchanged", paths: ["src/ProjectTree.tsx"], detail: "File is locked." });
    expect(await screen.findByText("Couldn't revert ProjectTree.tsx · File is locked. Nothing was changed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("offers Retry when a failed revert was rolled back", async () => {
    await applyWith({ status: "failed", outcome: "rolled_back", paths: ["src/ProjectTree.tsx"], detail: "Disk full" });
    expect(await screen.findByText("Couldn't revert ProjectTree.tsx · Disk full. Files were put back as they were.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("names the files it could not put back and offers no Retry", async () => {
    await applyWith({ status: "failed", outcome: "recovery_failed", paths: ["src/a.ts", "src/b.ts"], detail: "x" });
    expect(await screen.findByText("Couldn't put back 2 files: a.ts, b.ts. Check Review › Unstaged.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("re-renders with the new preview when the plan went stale", async () => {
    await applyWith({ status: "stale", preview: ready([file("src/ProjectTree.tsx", { state: "changed_later", changedBy: "outside" })]) });
    expect(await screen.findByText("ProjectTree.tsx changed after this turn. Reverting removes those changes too.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
  });

  it("closes and adds the receipt to the timeline on success", async () => {
    const onClose = await applyWith(reverted);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(useThreadStore.getState().records.get("thread-1")?.messages.map((m) => m.id)).toEqual(["receipt-1"]);
  });

  it("resends the same requestId after a dropped connection and shows one receipt", async () => {
    const onClose = await showPreview(ready([file("a.ts")]));
    transport.applyTurnRevert
      .mockRejectedValueOnce(new Error("WebSocket disconnected"))
      .mockResolvedValueOnce(reverted);
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const [first, second] = transport.applyTurnRevert.mock.calls.map(([params]) => params.requestId);
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
    expect(useThreadStore.getState().records.get("thread-1")?.messages).toHaveLength(1);
  });

  it("uses a new requestId when the user retries", async () => {
    await applyWith({ status: "failed", outcome: "unchanged", paths: ["a.ts"], detail: "locked" });
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    const ids = transport.applyTurnRevert.mock.calls.map(([params]) => params.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });
});
