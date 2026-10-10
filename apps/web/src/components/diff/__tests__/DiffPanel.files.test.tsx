import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewComparison, ReviewComparisonResult, TurnSnapshot } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { DiffPanel } from "../DiffPanel";

let measuredWidth = 900;
const transport = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn().mockResolvedValue(["src/App.tsx", "README.md"]),
  refreshWorkspaceFiles: vi.fn().mockResolvedValue(undefined),
  listSnapshots: vi.fn().mockResolvedValue([]),
  getSnapshotDiffStats: vi.fn().mockResolvedValue([]),
  getTurnDiffComparison: vi.fn(),
  getCumulativeDiffStats: vi.fn(),
  getReviewComparison: vi.fn(),
  listReviewTurns: vi.fn().mockResolvedValue([]),
}));

const EMPTY_READY: ReviewComparisonResult = { status: "ready", comparison: { files: [], additions: 0, deletions: 0 } };

vi.mock("@/hooks/useElementWidth", () => ({
  useElementWidth: () => measuredWidth,
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../DiffToolbar", () => ({
  DiffToolbar: () => null,
}));

vi.mock("../WorktreeFilesPane", () => ({
  WorktreeFilesPane: ({ files, error }: { files: readonly { path: string }[]; error: string | null }) => (
    <aside data-testid="worktree-files">{error ?? files.map((file) => file.path).join(",")}</aside>
  ),
}));

vi.mock("../LastTurnView", () => ({
  LastTurnView: ({ comparison, cacheVersion, refreshing, onRefresh }: {
    comparison: ReviewComparison | null;
    cacheVersion: string | number;
    refreshing: boolean;
    onRefresh: () => void;
  }) => (
    <section data-testid="snapshot-diff" data-snapshot-id={comparison?.turnDiff?.id ?? ""} data-cache-version={cacheVersion}>
      {comparison?.files.map((file) => file.path).join(",")}
      <button type="button" onClick={onRefresh} disabled={refreshing}>Refresh snapshot</button>
      {refreshing ? <span>Refreshing snapshot comparison</span> : null}
    </section>
  ),
}));
vi.mock("../CumulativeView", () => ({
  CumulativeView: ({ comparison, cacheVersion, refreshing, onRefresh }: {
    comparison: ReviewComparison | null;
    cacheVersion: string | number;
    refreshing: boolean;
    onRefresh: () => void;
  }) => (
    <section data-testid="cumulative-diff" data-cache-version={cacheVersion}>
      {comparison?.files.map((file) => file.path).join(",")}
      <button type="button" onClick={onRefresh} disabled={refreshing}>Refresh cumulative</button>
      {refreshing ? <span>Refreshing cumulative comparison</span> : null}
    </section>
  ),
}));
vi.mock("../FileList", () => ({
  FileList: ({ files, refreshing, onRefresh }: { files: { path: string }[]; refreshing: boolean; onRefresh: () => void }) => (
    <section data-testid="diff-files">
      {files.map((file) => file.path).join(",")}
      <button type="button" onClick={onRefresh}>Refresh</button>
      {refreshing ? <span>Refreshing comparison</span> : null}
    </section>
  ),
  ReviewStateControls: ({ onRefresh }: { onRefresh: () => void }) => (
    <button type="button" data-testid="review-state-controls" onClick={onRefresh}>Refresh controls</button>
  ),
}));

describe("DiffPanel worktree files", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
    return { promise, resolve, reject };
  }

  function snapshot(id: string, path: string): TurnSnapshot {
    return {
      id,
      thread_id: "thread-1",
      ref_before: `${id}-before`,
      ref_after: `${id}-after`,
      files_changed: [path],
      created_at: "2026-07-20T12:00:00.000Z",
    } as TurnSnapshot;
  }

  function ready(value: ReviewComparison): ReviewComparisonResult {
    return { status: "ready", comparison: value };
  }
  function file(path: string): ReviewComparison["files"][number] {
    return { path, previousPath: null, changeType: "modified", binary: false, additions: null, deletions: null, untracked: false };
  }
  function stats(path: string): ReviewComparisonResult {
    return ready({ files: [{ ...file(path), additions: 1, deletions: 0 }], additions: 1, deletions: 0 });
  }
  function comparison(id: string, path: string): ReviewComparisonResult {
    return ready({ files: [file(path)], additions: 1, deletions: 0,
      turnDiff: { id, phase: "settled", source: "native", fidelity: "agent", revision: 1 } });
  }
  beforeEach(() => {
    measuredWidth = 900;
    vi.clearAllMocks();
    transport.listSnapshots.mockReset().mockResolvedValue([]);
    transport.getSnapshotDiffStats.mockReset().mockResolvedValue([]);
    transport.getTurnDiffComparison.mockReset().mockResolvedValue(EMPTY_READY);
    transport.getCumulativeDiffStats.mockReset().mockResolvedValue(EMPTY_READY);
    transport.getReviewComparison.mockReset().mockResolvedValue(EMPTY_READY);
    transport.listReviewTurns.mockReset().mockResolvedValue([]);
    useWorkspaceStore.setState({
      activeThreadId: "thread-1",
      activeWorkspaceId: "workspace-1",
    });
    useDiffStore.setState({
      viewMode: "last-turn",
      snapshotsByThread: { "thread-1": [] },
      snapshotsLoadingByThread: {},
      reviewTurnsByThread: {},
      diffRevisionByScope: {},
      reviewFilesVisibleByScope: {},
    });
  });

  it("starts closed at wide widths and never requests the full worktree", async () => {
    render(<DiffPanel />);

    await screen.findByTestId("review-state");

    expect(screen.queryByTestId("worktree-files")).not.toBeInTheDocument();
    expect(transport.listWorkspaceFiles).not.toHaveBeenCalled();
    expect(useDiffStore.getState().reviewFilesVisibleByScope["thread-1"]).toBeFalsy();
  });

  it.each([false, true])("finishes the first snapshot load so native Last turn can render, failed=%s", async (failed) => {
    useDiffStore.setState({ snapshotsByThread: {} });
    const firstLoad = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReturnValueOnce(firstLoad.promise);
    transport.getTurnDiffComparison.mockResolvedValue(comparison("native-1", "agent.ts"));
    render(<DiffPanel />);
    expect(useDiffStore.getState().snapshotsLoadingByThread["thread-1"]).toBe(true);
    if (failed) firstLoad.reject(new Error("Snapshot list unavailable"));
    else firstLoad.resolve([]);
    await waitFor(() => expect(useDiffStore.getState().snapshotsLoadingByThread["thread-1"]).toBe(false));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("agent.ts"));
    transport.getTurnDiffComparison.mockResolvedValue(comparison("native-2", "refreshed.ts"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("refreshed.ts"));
  });

  it("hides invalidated Live files until the fresh comparison request settles", async () => {
    const live = ready({ files: [file("live.ts")], additions: 1, deletions: 0,
      turnDiff: { id: "live-1", phase: "live", source: "native", fidelity: "agent", revision: 1 } });
    const reconnect = deferred<ReviewComparisonResult>();
    transport.getTurnDiffComparison.mockResolvedValueOnce(live).mockReturnValueOnce(reconnect.promise);
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("live.ts"));
    act(() => { useDiffStore.getState().bumpDiffRevision("thread-1"); });
    expect(screen.queryByText("live.ts")).not.toBeInTheDocument();
    reconnect.resolve(comparison("settled-1", "settled.ts"));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("settled.ts"));
    expect(screen.getByTestId("snapshot-diff")).not.toHaveTextContent("live.ts");
  });

  it("forwards the picked turn's message id and reloads when it changes", async () => {
    useDiffStore.setState({
      viewMode: "turn",
      selectedTurnMessageIdByThread: { "thread-1": "msg-picked" },
    });
    transport.getTurnDiffComparison.mockResolvedValue(comparison("picked-1", "picked.ts"));

    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("picked.ts"));
    expect(transport.getTurnDiffComparison).toHaveBeenCalledWith("thread-1", "msg-picked");

    transport.getTurnDiffComparison.mockResolvedValue(comparison("picked-2", "other.ts"));
    act(() => { useDiffStore.getState().setReviewTurnForThread("thread-1", "msg-other"); });
    await waitFor(() => expect(transport.getTurnDiffComparison).toHaveBeenCalledWith("thread-1", "msg-other"));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("other.ts"));
  });

  it("never sends an operand-less request for an unpicked Turn view", async () => {
    useDiffStore.setState({ viewMode: "turn", selectedTurnMessageIdByThread: {} });
    render(<DiffPanel />);

    // Operand-less requests resolve live/latest state, which a picked-turn
    // view must not show. The panel settles empty without asking the server.
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveTextContent("No turns yet"));
    expect(transport.getTurnDiffComparison).not.toHaveBeenCalled();
  });

  it("stays collapsed in a compact diff even when the toggle requests Files", async () => {
    measuredWidth = 640;
    render(<DiffPanel />);

    expect(screen.queryByTestId("worktree-files")).not.toBeInTheDocument();
    act(() => { useDiffStore.getState().setReviewFilesVisible("thread-1", true); });

    // The pane never floats: below the docked minimum it collapses and the
    // visible flag stays set so it returns once the panel has room again.
    await waitFor(() =>
      expect(useDiffStore.getState().reviewFilesVisibleByScope["thread-1"]).toBe(true)
    );
    expect(screen.queryByTestId("worktree-files")).not.toBeInTheDocument();
    expect(transport.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("publishes one matching diff and Files result after a controlled refresh", async () => {
    const first = deferred<ReviewComparisonResult>();
    const second = deferred<ReviewComparisonResult>();
    transport.getReviewComparison.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
    useDiffStore.setState({ viewMode: "unstaged" });
    const user = userEvent.setup();

    render(<DiffPanel />);
    first.resolve(ready({ files: [file("old.ts")], additions: 1, deletions: 0 }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts"));
    act(() => { useDiffStore.getState().setReviewFilesVisible("workspace-1", true); });
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(transport.getReviewComparison).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");
    expect(screen.getByText("Refreshing comparison")).toBeInTheDocument();

    second.resolve(ready({ files: [file("new.ts")], additions: 2, deletions: 1 }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("new.ts"));
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("new.ts");
    expect(transport.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("keeps Last turn identity, diff, and Files atomic through refresh success and shows a comparison failure", async () => {
    const oldSnapshot = snapshot("snapshot-old", "old.ts");
    const nextSnapshot = snapshot("snapshot-next", "next.ts");
    const failedSnapshot = snapshot("snapshot-failed", "failed.ts");
    const initialStats = deferred<ReviewComparisonResult>();
    const nextList = deferred<TurnSnapshot[]>();
    const nextStats = deferred<ReviewComparisonResult>();
    const failedList = deferred<TurnSnapshot[]>();
    const failedStats = deferred<ReviewComparisonResult>();
    transport.getTurnDiffComparison.mockReset()
      .mockReturnValueOnce(initialStats.promise)
      .mockReturnValueOnce(nextStats.promise)
      .mockReturnValueOnce(failedStats.promise);
    transport.listSnapshots.mockReset()
      .mockReturnValueOnce(nextList.promise)
      .mockReturnValueOnce(failedList.promise);
    useDiffStore.setState({
      viewMode: "last-turn",
      snapshotsByThread: { "thread-1": [oldSnapshot] },
    });
    const user = userEvent.setup();

    render(<DiffPanel />);
    initialStats.resolve(comparison("snapshot-old", "old.ts"));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveAttribute("data-snapshot-id", "snapshot-old"));
    act(() => { useDiffStore.getState().setReviewFilesVisible("thread-1", true); });
    expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    nextList.resolve([nextSnapshot]);
    await waitFor(() => expect(transport.getTurnDiffComparison).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("snapshot-diff")).toHaveAttribute("data-snapshot-id", "snapshot-old");
    expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    nextStats.resolve(comparison("snapshot-next", "next.ts"));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveAttribute("data-snapshot-id", "snapshot-next"));
    expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("next.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("next.ts");

    await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    failedList.resolve([failedSnapshot]);
    await waitFor(() => expect(transport.getTurnDiffComparison).toHaveBeenCalledTimes(3));
    failedStats.reject(new Error("stats failed"));
    // A failed refresh reads as a failure, never as the previous comparison.
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    expect(screen.queryByTestId("snapshot-diff")).not.toBeInTheDocument();
    expect(screen.queryByTestId("worktree-files")).not.toHaveTextContent("next.ts");
  });

  it("keeps All turns cache identity, diff, and Files atomic through refresh success and shows a stats failure", async () => {
    const oldSnapshot = snapshot("snapshot-old", "old.ts");
    const nextSnapshot = snapshot("snapshot-next", "next.ts");
    const failedSnapshot = snapshot("snapshot-failed", "failed.ts");
    const initialStats = deferred<ReviewComparisonResult>();
    const nextList = deferred<TurnSnapshot[]>();
    const nextStats = deferred<ReviewComparisonResult>();
    const failedList = deferred<TurnSnapshot[]>();
    const failedStats = deferred<ReviewComparisonResult>();
    transport.getCumulativeDiffStats.mockReset()
      .mockReturnValueOnce(initialStats.promise)
      .mockReturnValueOnce(nextStats.promise)
      .mockReturnValueOnce(failedStats.promise);
    transport.listSnapshots.mockReset()
      .mockReturnValueOnce(nextList.promise)
      .mockReturnValueOnce(failedList.promise);
    useDiffStore.setState({
      viewMode: "cumulative",
      snapshotsByThread: { "thread-1": [oldSnapshot] },
    });
    const user = userEvent.setup();

    render(<DiffPanel />);
    initialStats.resolve(stats("old.ts"));
    await waitFor(() => expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("old.ts"));
    act(() => { useDiffStore.getState().setReviewFilesVisible("thread-1", true); });
    const oldVersion = screen.getByTestId("cumulative-diff").getAttribute("data-cache-version");

    await user.click(screen.getByRole("button", { name: "Refresh cumulative" }));
    nextList.resolve([nextSnapshot]);
    await waitFor(() => expect(transport.getCumulativeDiffStats).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("cumulative-diff")).toHaveAttribute("data-cache-version", oldVersion);
    expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    nextStats.resolve(stats("next.ts"));
    await waitFor(() => expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("next.ts"));
    expect(screen.getByTestId("cumulative-diff")).not.toHaveAttribute("data-cache-version", oldVersion);
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("next.ts");

    await user.click(screen.getByRole("button", { name: "Refresh cumulative" }));
    failedList.resolve([failedSnapshot]);
    await waitFor(() => expect(transport.getCumulativeDiffStats).toHaveBeenCalledTimes(3));
    failedStats.reject(new Error("stats failed"));
    // A failed refresh reads as a failure, never as the previous comparison.
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    expect(screen.queryByTestId("cumulative-diff")).not.toBeInTheDocument();
    expect(screen.queryByTestId("worktree-files")).not.toHaveTextContent("next.ts");
  });

  it("ignores an unresolved snapshot refresh after the active scope changes", async () => {
    transport.getTurnDiffComparison.mockResolvedValueOnce(comparison("snapshot-old", "old.ts"));
    const oldSnapshot = snapshot("snapshot-old", "old.ts");
    const staleList = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReset().mockReturnValueOnce(staleList.promise);
    useDiffStore.setState({
      viewMode: "last-turn",
      snapshotsByThread: { "thread-1": [oldSnapshot] },
    });
    const user = userEvent.setup();

    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("old.ts"));
    await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    act(() => {
      useWorkspaceStore.setState({ activeThreadId: "thread-2" });
      useDiffStore.setState({ snapshotsByThread: { "thread-1": [oldSnapshot], "thread-2": [] } });
    });
    staleList.resolve([snapshot("snapshot-stale", "stale.ts")]);

    await waitFor(() => expect(useDiffStore.getState().snapshotsByThread["thread-1"]).toEqual([oldSnapshot]));
    expect(screen.queryByText("stale.ts")).not.toBeInTheDocument();
  });

  function renderUnstaged(result: ReviewComparisonResult) {
    transport.getReviewComparison.mockReset().mockResolvedValue(result);
    useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
    useDiffStore.setState({ viewMode: "unstaged", reviewViewMenuOpen: false });
    render(<DiffPanel />);
  }

  it.each<[string, ReviewComparisonResult, string, string]>([
    ["empty", EMPTY_READY, "empty", "No unstaged changes"],
    ["too-many-files", { status: "too-many-files", fileCount: 12_345, limit: 10_000 }, "too-many-files", "12,345 changed files. Review shows up to 10,000."],
    ["failed", { status: "failed", failure: { kind: "timeout", summary: "git diff timed out", detail: "stderr" } }, "failed", "git diff timed out"],
    ["unborn", { status: "unavailable", reason: "unborn" }, "empty", "No commits yet"],
    ["snapshot-expired", { status: "unavailable", reason: "snapshot-expired" }, "gone", "Snapshots older than 30 days are cleared"],
  ])("renders the %s outcome as its own body, never as files", async (_label, result, kind, text) => {
    renderUnstaged(result);

    const body = await screen.findByTestId("review-state");
    expect(body).toHaveAttribute("data-review-state", kind);
    expect(body).toHaveTextContent(text);
    expect(screen.queryByTestId("diff-files")).not.toBeInTheDocument();
    // Refresh and Files stay reachable when there is no file list to own them.
    expect(screen.getByTestId("review-state-controls")).toBeInTheDocument();
  });

  it.each<[string, ReviewComparisonResult, string]>([
    ["failed", { status: "failed", failure: { kind: "timeout", summary: "git diff timed out", detail: "stderr" } }, "Couldn't load this comparison"],
    ["too-many-files", { status: "too-many-files", fileCount: 12_345, limit: 10_000 }, "Too many files to show"],
  ])("tells the Files pane the %s outcome instead of listing no files", async (_label, result, notice) => {
    renderUnstaged(result);
    await screen.findByTestId("review-state");
    act(() => { useDiffStore.getState().setReviewFilesVisible("workspace-1", true); });

    expect(screen.getByTestId("worktree-files")).toHaveTextContent(notice);
  });

  it("reports a turn list that never loaded and retries the list", async () => {
    transport.listReviewTurns.mockReset().mockRejectedValueOnce(new Error("turns offline")).mockResolvedValueOnce([]);
    useDiffStore.setState({ viewMode: "turn", selectedTurnMessageIdByThread: {}, reviewTurnsErrorByThread: {} });
    const user = userEvent.setup();
    render(<DiffPanel />);

    const body = await screen.findByTestId("review-state");
    await waitFor(() => expect(body).toHaveAttribute("data-review-state", "failed"));
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("review-failure-detail")).toHaveTextContent("turns offline");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveTextContent("No turns yet"));
    expect(transport.listReviewTurns).toHaveBeenCalledTimes(2);
    expect(transport.getTurnDiffComparison).not.toHaveBeenCalled();
  });

  it("retries a failed turn comparison, not the list, when a loaded list's refetch failed", async () => {
    transport.listReviewTurns.mockReset().mockRejectedValue(new Error("turns offline"));
    transport.getTurnDiffComparison.mockReset()
      .mockResolvedValue({ status: "failed", failure: { kind: "git-error", summary: "Git reported an error", detail: "fatal" } });
    useDiffStore.setState({
      viewMode: "turn",
      selectedTurnMessageIdByThread: { "thread-1": "msg-picked" },
      reviewTurnsByThread: { "thread-1": [] },
      reviewTurnsErrorByThread: {},
    });
    const user = userEvent.setup();
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    await waitFor(() => expect(useDiffStore.getState().reviewTurnsErrorByThread["thread-1"]).toBe("turns offline"));
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    transport.getTurnDiffComparison.mockResolvedValue(comparison("picked-1", "picked.ts"));

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("picked.ts"));
  });

  it("replaces the shown comparison when a refresh cannot list snapshots", async () => {
    transport.getCumulativeDiffStats.mockReset().mockResolvedValue(stats("old.ts"));
    transport.listSnapshots.mockReset().mockRejectedValueOnce(new Error("snapshots offline"));
    useDiffStore.setState({ viewMode: "cumulative", snapshotsByThread: { "thread-1": [snapshot("snapshot-old", "old.ts")] } });
    const user = userEvent.setup();
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("old.ts"));

    await user.click(screen.getByRole("button", { name: "Refresh cumulative" }));

    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    expect(screen.queryByTestId("cumulative-diff")).not.toBeInTheDocument();
    transport.listSnapshots.mockResolvedValue([snapshot("snapshot-old", "old.ts")]);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("old.ts"));
  });

  it("shows failure details, copies them, and retries the comparison", async () => {
    const detail = "fatal: bad object HEAD\nexit code 128";
    renderUnstaged({ status: "failed", failure: { kind: "git-error", summary: "Git couldn't read the repository", detail } });
    // userEvent installs its own clipboard, so read back what was copied.
    const user = userEvent.setup();

    await screen.findByText("Couldn't load this comparison");
    expect(screen.queryByTestId("review-failure-detail")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("review-failure-detail").textContent).toBe(detail);
    await user.click(screen.getByRole("button", { name: "Copy error details" }));
    await expect(navigator.clipboard.readText()).resolves.toBe(detail);

    transport.getReviewComparison.mockResolvedValue(stats("fixed.ts"));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("fixed.ts"));
    expect(transport.getReviewComparison).toHaveBeenCalledTimes(2);
  });

  it("names a request that never answered as a failure with its message", async () => {
    transport.getReviewComparison.mockReset().mockRejectedValue(new Error("socket closed"));
    useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
    useDiffStore.setState({ viewMode: "unstaged" });
    render(<DiffPanel />);

    const body = await screen.findByTestId("review-state");
    expect(body).toHaveTextContent("The request didn't complete");
    await userEvent.setup().click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("review-failure-detail")).toHaveTextContent("socket closed");
  });

  it("opens the view menu from the too-many-files body", async () => {
    renderUnstaged({ status: "too-many-files", fileCount: 20_000, limit: 10_000 });

    await userEvent.setup().click(await screen.findByRole("button", { name: "Choose another view" }));
    expect(useDiffStore.getState().reviewViewMenuOpen).toBe(true);
  });

});
