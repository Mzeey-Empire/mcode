import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnSnapshot } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { TurnChangeSummary } from "../TurnChangeSummary";

const transport = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  getSnapshotDiffStats: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

vi.mock("@/stores/thread-selectors", () => ({
  readThreadRecord: () => ({ serverMessageIds: {} }),
}));

const showRightPanelAdaptive = vi.hoisted(() => vi.fn());
vi.mock("@/lib/right-panel-layout", () => ({
  showRightPanelAdaptive,
}));

function snapshot(id: string, messageId: string): TurnSnapshot {
  return {
    id,
    thread_id: "thread-1",
    worktree_path: null,
    message_id: messageId,
    ref_before: `${id}-before`,
    ref_after: `${id}-after`,
    files_changed: [],
    created_at: "2026-07-20T12:00:00.000Z",
  };
}

function renderSummary(
  filesChanged: string[],
  overrides: { isLatestTurn?: boolean; messageId?: string; manualExpandRef?: React.RefObject<Map<string, boolean>> } = {},
) {
  return render(
    <TurnChangeSummary
      messageId={overrides.messageId ?? "msg-1"}
      filesChanged={filesChanged}
      isLatestTurn={overrides.isLatestTurn ?? true}
      manualExpandRef={overrides.manualExpandRef}
    />,
  );
}

describe("TurnChangeSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.listSnapshots.mockResolvedValue([]);
    transport.getSnapshotDiffStats.mockResolvedValue([]);
    useWorkspaceStore.setState({
      activeThreadId: "thread-1",
      activeWorkspaceId: "workspace-1",
    });
    useDiffStore.setState({
      snapshotsByThread: { "thread-1": [snapshot("snap-1", "msg-1")] },
      reviewFileJumpRequest: null,
      selectedTurnMessageIdByThread: {},
      reviewViewByThread: {},
      reviewViewManuallySelectedByThread: {},
      viewMode: "last-turn",
    });
  });

  it("shows per-file change glyphs and line stats from snapshot stats", async () => {
    transport.getSnapshotDiffStats.mockResolvedValue([
      { filePath: "src/App.tsx", additions: 8, deletions: 2, changeType: "modified" },
      { filePath: "src/new.ts", additions: 12, deletions: 0, changeType: "added" },
      { filePath: "src/old.ts", additions: 0, deletions: 30, changeType: "deleted" },
    ]);

    renderSummary(["src/App.tsx", "src/new.ts", "src/old.ts"]);

    await waitFor(() => expect(transport.getSnapshotDiffStats).toHaveBeenCalledWith("snap-1"));

    expect(screen.getByRole("button", { name: "Modified src/App.tsx" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Added src/new.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deleted src/old.ts" })).toBeInTheDocument();
    expect(screen.getByText("+8")).toBeInTheDocument();
    expect(screen.getByText("−30")).toBeInTheDocument();
  });

  it("opens the Changes tab and jumps to the clicked file", async () => {
    transport.getSnapshotDiffStats.mockResolvedValue([
      { filePath: "src/App.tsx", additions: 8, deletions: 2, changeType: "modified" },
    ]);
    const user = userEvent.setup();

    renderSummary(["src/App.tsx"]);

    await user.click(await screen.findByRole("button", { name: "Modified src/App.tsx" }));

    await waitFor(() => {
      expect(showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
    });
    const jump = useDiffStore.getState().reviewFileJumpRequest;
    expect(jump).toMatchObject({ scopeId: "thread-1", path: "src/App.tsx", viewKey: "turn:msg-1" });
    expect(useDiffStore.getState().reviewViewByThread["thread-1"]).toBe("turn");
    expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBe("msg-1");
  });

  it("opens the Turn view scoped to the clicked turn's message", async () => {
    const user = userEvent.setup();
    renderSummary(["src/App.tsx"]);

    await user.click(screen.getByRole("button", { name: /view diff/i }));

    await waitFor(() => {
      expect(showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
    });
    expect(useDiffStore.getState().reviewViewByThread["thread-1"]).toBe("turn");
    expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBe("msg-1");
  });

  it("falls back to All turns when the turn cannot be resolved to a snapshot", async () => {
    const user = userEvent.setup();
    render(<TurnChangeSummary messageId="msg-unknown" filesChanged={["src/App.tsx"]} isLatestTurn={false} />);

    await user.click(screen.getByRole("button", { name: /view diff/i }));

    await waitFor(() => {
      expect(showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
    });
    expect(useDiffStore.getState().reviewViewByThread["thread-1"]).toBe("cumulative");
    expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBeUndefined();
  });

  it("restores manual expansion across remounts via manualExpandRef", () => {
    const manualExpandRef = { current: new Map<string, boolean>([["msg-1", false]]) };

    renderSummary(["src/App.tsx"], { isLatestTurn: true, manualExpandRef });

    expect(screen.queryByRole("button", { name: /src\/App\.tsx/ })).not.toBeInTheDocument();
  });

  it("caps the rendered list and offers a View all diffs escape", async () => {
    const manyFiles = Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts`);
    transport.getSnapshotDiffStats.mockResolvedValue(
      manyFiles.map((filePath) => ({ filePath, additions: 1, deletions: 0, changeType: "modified" })),
    );

    renderSummary(manyFiles);

    expect(await screen.findByRole("button", { name: "Modified src/file-4.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Modified src/file-5.ts" })).not.toBeInTheDocument();
    expect(screen.getByText(/\+3 more files/)).toBeInTheDocument();
  });

  it("groups nested files under folder headers and keeps root files flat", async () => {
    renderSummary(["agent.txt", "src/util/a.ts", "src/util/b.ts", "docs/g.md"]);

    // Single-child chains compress into one header ("src/util" not "src" + "util").
    expect(await screen.findByText("src/util")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
    // Root file has no folder header; its row keeps the file aria-label.
    expect(screen.getByRole("button", { name: "Modified agent.txt" })).toBeInTheDocument();
  });

  it("nests shared parents once and collapses folder children on toggle", async () => {
    const user = userEvent.setup();
    renderSummary([
      "apps/web/src/a.ts",
      "apps/web/src/b.ts",
      "apps/server/src/c.ts",
    ]);

    // "apps" branches, so it renders once as a parent; chains below compress.
    const appsHeader = await screen.findByText("apps");
    expect(screen.getByText("web/src")).toBeInTheDocument();
    expect(screen.getByText("server/src")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Modified apps/web/src/a.ts" })).toBeInTheDocument();

    await user.click(appsHeader);
    expect(screen.queryByRole("button", { name: "Modified apps/web/src/a.ts" })).not.toBeInTheDocument();
    expect(screen.queryByText("web/src")).not.toBeInTheDocument();
  });

  it("parses Windows-style paths into folders, basenames, and stats", async () => {
    // Git stats arrive with "/" separators even when files_changed uses "\".
    transport.getSnapshotDiffStats.mockResolvedValue([
      {
        filePath: ".dev/task-briefs/issue-37-keygen-migration.md",
        additions: 42,
        deletions: 0,
        changeType: "added",
      },
    ]);

    renderSummary([".dev\\task-briefs\\issue-37-keygen-migration.md"]);

    expect(await screen.findByText(".dev/task-briefs")).toBeInTheDocument();
    const row = screen.getByRole("button", {
      name: "Added .dev\\task-briefs\\issue-37-keygen-migration.md",
    });
    expect(row).toHaveTextContent("issue-37-keygen-migration.md");
    expect(row).toHaveTextContent("+42");
  });

  it("does not fetch stats while collapsed", async () => {
    renderSummary(["src/App.tsx"], { isLatestTurn: false });

    expect(screen.getByText("1 file changed")).toBeInTheDocument();
    await act(async () => {});
    expect(transport.getSnapshotDiffStats).not.toHaveBeenCalled();
  });
});
