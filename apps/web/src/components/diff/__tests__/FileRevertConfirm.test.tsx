import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RevertFilePlan, TurnRevertPreview, TurnRevertResult } from "@mcode/contracts";
import { createMockMessage } from "@/__tests__/mocks/transport";
import { useThreadStore } from "@/stores/threadStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { FileRevertConfirm } from "../FileRevertConfirm";

const transport = vi.hoisted(() => ({
  previewTurnRevert: vi.fn(),
  applyTurnRevert: vi.fn(),
  listSnapshots: vi.fn(),
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

type ReadyPreview = Extract<TurnRevertPreview, { status: "ready" }>;

const PATH = "apps/web/src/ThreadActionsMenu.tsx";

function plan(path: string, overrides: Partial<RevertFilePlan> = {}): RevertFilePlan {
  return { path, action: "restore", state: "clean", binary: false, ...overrides };
}

function ready(files: RevertFilePlan[], token = "token-1"): ReadyPreview {
  return { status: "ready", previewToken: token, files, skipped: [], unattributedChangeCount: 0 };
}

const reverted: TurnRevertResult = {
  status: "reverted",
  receipt: createMockMessage({
    id: "receipt-1",
    thread_id: "thread-1",
    role: "system",
    content: `Reverted ${PATH} · Turn 3`,
    systemNotice: { kind: "turn-reverted", presentation: "timeline", revertId: "revert-1" },
  }),
  revert: {
    id: "revert-1", threadId: "thread-1", targetMessageId: "msg-3", fromMessageId: null, kind: "file", path: PATH,
    undoesRevertId: null, undoneByRevertId: null, files: [], receiptMessageId: "receipt-1", createdAt: "2026-10-14T10:00:00.000Z",
  },
};

interface Props { messageId?: string; fromMessageId?: string; range?: { from: number; to: number } }

function renderConfirm({ messageId = "msg-3", fromMessageId, range = { from: 3, to: 3 } }: Props = {}) {
  const onClose = vi.fn();
  render(<FileRevertConfirm threadId="thread-1" path={PATH} messageId={messageId} fromMessageId={fromMessageId} range={range} onClose={onClose} />);
  return onClose;
}

async function settled() {
  await waitFor(() => expect(screen.queryByText("Checking files…")).not.toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.listSnapshots.mockResolvedValue([]);
  useThreadStore.setState({ records: new Map([["thread-1", createEmptyThreadRecord()]]) });
});

describe("FileRevertConfirm in the Turn view", () => {
  it("asks about one file and leaves the turn's other edits alone", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([plan(PATH)]));
    renderConfirm();
    await settled();
    expect(transport.previewTurnRevert).toHaveBeenCalledWith("thread-1", "msg-3", { kind: "file", path: PATH });
    expect(screen.getByText("Revert ThreadActionsMenu.tsx to before Turn 3?")).toBeInTheDocument();
    expect(screen.getByText("Only this file changes. The turn's other edits stay.")).toBeInTheDocument();
  });

  it("applies the previewed file scope and closes on success", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([plan(PATH)]));
    transport.applyTurnRevert.mockResolvedValue(reverted);
    const onClose = renderConfirm();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(transport.applyTurnRevert).toHaveBeenCalledWith({
      threadId: "thread-1", messageId: "msg-3", scope: { kind: "file", path: PATH }, previewToken: "token-1", requestId: expect.any(String),
    });
  });

  it("keeps the later-edit warning after the lead sentence", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([plan(PATH, { state: "changed_later", changedBy: "later_turn" })]));
    renderConfirm();
    await settled();
    expect(screen.getByText(/^Only this file changes\. The turn's other edits stay\. ThreadActionsMenu\.tsx was edited by a later turn\./)).toBeInTheDocument();
  });
});

describe("FileRevertConfirm over All turns", () => {
  const range = { from: 1, to: 5 };

  it("sends the first turn as fromMessageId and names the range", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([plan(PATH)]));
    transport.applyTurnRevert.mockResolvedValue(reverted);
    renderConfirm({ messageId: "msg-5", fromMessageId: "msg-1", range });
    await settled();
    expect(transport.previewTurnRevert).toHaveBeenCalledWith("thread-1", "msg-5", { kind: "file", path: PATH, fromMessageId: "msg-1" });
    expect(screen.getByText("Revert ThreadActionsMenu.tsx to before Turn 1?")).toBeInTheDocument();
    expect(screen.getByText("Only this file changes. Its changes from Turns 1–5 are undone, and other files stay.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(transport.applyTurnRevert).toHaveBeenCalledOnce());
    expect(transport.applyTurnRevert.mock.calls[0]?.[0]).toMatchObject({
      messageId: "msg-5", scope: { kind: "file", path: PATH, fromMessageId: "msg-1" },
    });
  });

  it("says when the file changed after the range", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([plan(PATH, { state: "changed_later", changedBy: "outside" })]));
    renderConfirm({ messageId: "msg-5", fromMessageId: "msg-1", range });
    await settled();
    expect(screen.getByText(/ThreadActionsMenu\.tsx changed after Turn 5\. Reverting removes those changes too\.$/)).toBeInTheDocument();
  });
});

describe("FileRevertConfirm rename chains", () => {
  it("names the restored and removed paths in the first sentence", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([
      plan("a.ts", { action: "recreate" }),
      plan("b.ts", { state: "already_reverted", action: "restore" }),
      plan("c.ts", { action: "delete", previousPath: "a.ts" }),
    ]));
    renderConfirm({ messageId: "msg-3", fromMessageId: "msg-1", range: { from: 1, to: 3 } });
    await settled();
    expect(screen.getByText("Restores a.ts and removes c.ts. Its changes from Turns 1–3 are undone, and other files stay.")).toBeInTheDocument();
    expect(screen.queryByText(/Only this file changes/)).not.toBeInTheDocument();
  });
});

describe("FileRevertConfirm cross-directory renames", () => {
  it("uses full paths when the restored and removed files share a basename", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([
      plan("src/old/Foo.tsx", { action: "recreate" }),
      plan("src/new/Foo.tsx", { action: "delete", previousPath: "src/old/Foo.tsx" }),
    ]));
    renderConfirm({ messageId: "msg-3", fromMessageId: "msg-1", range: { from: 1, to: 3 } });
    await settled();
    expect(screen.getByText(/^Restores src\/old\/Foo\.tsx and removes src\/new\/Foo\.tsx\./)).toBeInTheDocument();
  });
});

describe("FileRevertConfirm outcomes", () => {
  it("sends a new requestId for each Revert click and re-renders a stale preview", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([plan(PATH)]));
    transport.applyTurnRevert
      .mockResolvedValueOnce({ status: "stale", preview: ready([plan(PATH, { state: "changed_later", changedBy: "outside" })], "token-2") })
      .mockResolvedValueOnce(reverted);
    renderConfirm();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(await screen.findByText(/changed after this turn/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(transport.applyTurnRevert).toHaveBeenCalledTimes(2));
    const [first, second] = transport.applyTurnRevert.mock.calls.map(([params]) => params as { requestId: string; previewToken: string });
    expect(second?.previewToken).toBe("token-2");
    expect(second?.requestId).not.toBe(first?.requestId);
  });

  it("shows a failure in place and keeps the file untouched on Cancel", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([plan(PATH)]));
    transport.applyTurnRevert.mockResolvedValue({ status: "failed", outcome: "unchanged", paths: [PATH], detail: "Permission denied." });
    const onClose = renderConfirm();
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(await screen.findByText("Couldn't revert ThreadActionsMenu.tsx · Permission denied. Nothing was changed.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels on Esc without applying", async () => {
    transport.previewTurnRevert.mockResolvedValue(ready([plan(PATH)]));
    const onClose = renderConfirm();
    await settled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(transport.applyTurnRevert).not.toHaveBeenCalled();
  });
});
