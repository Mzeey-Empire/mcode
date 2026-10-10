import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReviewTurn } from "@mcode/contracts";
import { createRightPanelState, useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { refreshTurnSnapshotsAfterPersist } from "@/lib/turn-snapshot-refresh";
import { mockTransport, createMockThread } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-refresh";

describe("refreshTurnSnapshotsAfterPersist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      snapshotsByThread: {},
      diffRevisionByScope: {},
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
      viewMode: "last-turn",
    });
    useWorkspaceStore.setState({
      activeThreadId: THREAD_ID,
      threads: [
        createMockThread({
          id: THREAD_ID,
          workspace_id: "ws-1",
          has_file_changes: true,
        }),
      ],
    });
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "snap-1",
        thread_id: THREAD_ID,
        message_id: "msg-1",
        files_changed: ["src/a.ts"],
        ref_before: "aaa",
        ref_after: "bbb",
        worktree_path: null,
        attempt_count: 1,
        created_at: new Date().toISOString(),
      },
    ]);
  });

  it("loaded snapshots when the Review panel had never fetched them", async () => {
    refreshTurnSnapshotsAfterPersist(THREAD_ID, ["src/a.ts"]);
    await vi.waitFor(() => {
      expect(mockTransport.listSnapshots).toHaveBeenCalledWith(THREAD_ID);
    });
    expect(useDiffStore.getState().snapshotsByThread[THREAD_ID]).toHaveLength(1);
  });

  it("refetches a loaded turn list after a turn that changed no files", async () => {
    const turn: ReviewTurn = {
      messageId: "msg-2",
      ordinal: 2,
      createdAt: new Date().toISOString(),
      phase: "settled",
      fileCount: 0,
      additions: 0,
      deletions: 0,
      evidence: null,
      availability: "available",
    };
    useDiffStore.setState({ reviewTurnsByThread: { [THREAD_ID]: [] }, reviewTurnsErrorByThread: {} });
    (mockTransport.listReviewTurns as ReturnType<typeof vi.fn>).mockResolvedValueOnce([turn]);

    refreshTurnSnapshotsAfterPersist(THREAD_ID, []);

    await vi.waitFor(() => {
      expect(useDiffStore.getState().reviewTurnsByThread[THREAD_ID]).toEqual([turn]);
    });
    expect(mockTransport.listSnapshots).not.toHaveBeenCalled();
  });

  it("leaves an unloaded turn list for the Turn view to fetch", () => {
    useDiffStore.setState({ reviewTurnsByThread: {}, reviewTurnsErrorByThread: {} });

    refreshTurnSnapshotsAfterPersist(THREAD_ID, []);

    expect(mockTransport.listReviewTurns).not.toHaveBeenCalled();
  });

  it("refetched in place while the cumulative view is open on the active thread", async () => {
    useDiffStore.setState({
      snapshotsByThread: { [THREAD_ID]: [] },
      rightPanelByThread: {
        [THREAD_ID]: createRightPanelState({
          visible: true,
          width: 400,
          tabInstances: [{ id: "singleton:changes", type: "changes" }],
          activeTabId: "singleton:changes",
        }),
      },
      viewMode: "cumulative",
    });

    refreshTurnSnapshotsAfterPersist(THREAD_ID, ["src/a.ts"]);

    await vi.waitFor(() => {
      expect(useDiffStore.getState().snapshotsByThread[THREAD_ID]).toHaveLength(1);
    });
  });
});
