import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewComparison, ReviewComparisonResult, ReviewTurn, TurnSnapshot } from "@mcode/contracts";
import { createMockWorkspace } from "@/__tests__/mocks/transport";
import { useDiffStore, type DiffViewMode } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { DiffPanel } from "../DiffPanel";

let measuredWidth = 900;
const transport = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn().mockResolvedValue({ paths: ["src/App.tsx", "README.md"], truncated: false }),
  refreshWorkspaceFiles: vi.fn().mockResolvedValue(undefined),
  listSnapshots: vi.fn().mockResolvedValue([]),
  getSnapshotDiffStats: vi.fn().mockResolvedValue([]),
  getTurnDiffComparison: vi.fn(),
  getCumulativeDiffStats: vi.fn(),
  getReviewComparison: vi.fn(),
  getReviewState: vi.fn(),
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

vi.mock("../FilesDockedPane", () => ({
  FilesDockedPane: ({ files, error }: { files: readonly { path: string }[]; error: string | null }) => (
    <aside data-testid="worktree-files">{error ?? files.map((file) => file.path).join(",")}</aside>
  ),
}));

vi.mock("../CommitOperandPicker", () => ({ CommitOperandPicker: () => <span>commit picker</span> }));
vi.mock("../BranchOperandPickers", () => ({ BranchOperandPickers: () => <span>branch pickers</span> }));

// Every view's body is a FileList; the stub exposes which comparison it was handed.
vi.mock("../FileList", () => ({
  FileList: ({ files, source, id, cacheVersion, ignoreWhitespace }: {
    files: readonly { path: string }[];
    source: string;
    id: string;
    cacheVersion: string | number;
    ignoreWhitespace?: boolean;
  }) => (
    <section
      data-testid="diff-files"
      data-source={source}
      data-id={id}
      data-cache-version={cacheVersion}
      data-ignore-whitespace={ignoreWhitespace ? "true" : "false"}
    >
      {files.map((file) => file.path).join(",")}
    </section>
  ),
}));

describe("DiffPanel", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
    return { promise, resolve, reject };
  }

  /** Every call answers with whatever the gate holds when it settles, so reload counts don't matter. */
  function gate<T>(mock: ReturnType<typeof vi.fn>) {
    let current = deferred<T>();
    mock.mockReset().mockImplementation(() => current.promise);
    return {
      resolve: (value: T) => current.resolve(value),
      reject: (reason: unknown) => current.reject(reason),
      reopen: () => { current = deferred<T>(); },
    };
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

  function turn(messageId: string, ordinal: number, phase: ReviewTurn["phase"] = "settled"): ReviewTurn {
    return {
      messageId, ordinal, createdAt: "2026-07-20T12:00:00.000Z", phase,
      fileCount: 1, additions: 1, deletions: 0, evidence: "native", availability: "available",
    };
  }

  function ready(value: ReviewComparison): ReviewComparisonResult {
    return { status: "ready", comparison: value };
  }
  function file(path: string): ReviewComparison["files"][number] {
    return { path, previousPath: null, changeType: "modified", binary: false, additions: null, deletions: null, untracked: false };
  }
  function stats(...paths: string[]): ReviewComparisonResult {
    return ready({ files: paths.map((path) => ({ ...file(path), additions: 1, deletions: 0 })), additions: paths.length, deletions: 0 });
  }
  function comparison(id: string, path: string): ReviewComparisonResult {
    return ready({ files: [file(path)], additions: 1, deletions: 0,
      turnDiff: { id, phase: "settled", source: "native", fidelity: "agent", revision: 1 } });
  }

  /** A thread's view is its sticky pick; the header would otherwise move it to the ADR-0011 default. */
  function pickThreadView(viewMode: DiffViewMode) {
    useDiffStore.setState({
      viewMode,
      reviewViewByThread: { "thread-1": viewMode },
      reviewViewManuallySelectedByThread: { "thread-1": true },
    });
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
    // An unanswered probe treats every git view as available and holds the
    // header's view sync, so each test keeps the view it sets.
    transport.getReviewState.mockReset().mockReturnValue(new Promise(() => {}));
    useWorkspaceStore.setState({
      activeThreadId: "thread-1",
      activeWorkspaceId: "workspace-1",
      threads: [],
      workspaces: [createMockWorkspace({ id: "workspace-1", is_git_repo: true })],
    });
    useDiffStore.setState({
      viewMode: "turn",
      reviewViewByThread: {},
      reviewViewManuallySelectedByThread: {},
      selectedTurnByThread: {},
      snapshotsByThread: { "thread-1": [] },
      snapshotsLoadingByThread: {},
      reviewTurnsByThread: {},
      reviewTurnsErrorByThread: {},
      diffRevisionByScope: {},
      reviewFilesVisibleByScope: {},
      lineWrapByThread: {},
      ignoreWhitespaceByThread: {},
      bulkDiffExpand: null,
      reviewViewMenuOpen: false,
    });
  });

  it("starts closed at wide widths and never requests the full worktree", async () => {
    render(<DiffPanel />);

    await screen.findByTestId("review-state");

    expect(screen.queryByTestId("worktree-files")).not.toBeInTheDocument();
    expect(transport.listWorkspaceFiles).not.toHaveBeenCalled();
    expect(useDiffStore.getState().reviewFilesVisibleByScope["thread-1"]).toBeFalsy();
  });

  it("starts with Wrap on", async () => {
    render(<DiffPanel />);

    await screen.findByTestId("review-state");
    expect(screen.getByTestId("review-wrap-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("hides whitespace-only files in Git views, keeps the choice across views, and remembers it", async () => {
    pickThreadView("unstaged");
    transport.getReviewComparison.mockImplementation((params: { ignoreWhitespace?: boolean }) =>
      Promise.resolve(params.ignoreWhitespace ? stats("logic.ts") : stats("logic.ts", "indent.ts")));
    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("logic.ts,indent.ts"));
    expect(screen.getByTestId("review-stat-summary")).toHaveTextContent(/^2 files\s*\+2/);
    const toggle = screen.getByTestId("review-whitespace-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAccessibleName("Hide whitespace changes");

    await userEvent.setup().click(toggle);
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent(/^logic\.ts$/));
    expect(screen.getByTestId("review-stat-summary")).toHaveTextContent(/^1 file\s*\+1/);
    expect(transport.getReviewComparison).toHaveBeenLastCalledWith(expect.objectContaining({ view: "unstaged", ignoreWhitespace: true }));
    expect(screen.getByTestId("diff-files")).toHaveAttribute("data-ignore-whitespace", "true");
    expect(screen.getByTestId("review-whitespace-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("mcode.review-ignore-whitespace.v1") ?? "{}")).toEqual({ "thread-1": true });

    act(() => pickThreadView("staged"));
    await waitFor(() => expect(transport.getReviewComparison).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "staged", ignoreWhitespace: true }),
    ));
  });

  it("dims the whitespace control on an agent patch and leaves the patch alone", async () => {
    useDiffStore.setState({ ignoreWhitespaceByThread: { "thread-1": true } });
    transport.listReviewTurns.mockResolvedValue([turn("msg-1", 1)]);
    transport.getTurnDiffComparison.mockResolvedValue(comparison("native-1", "agent.ts"));
    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("agent.ts"));
    const toggle = screen.getByTestId("review-whitespace-toggle");
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAccessibleDescription("Not available for agent patches");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.setup().hover(toggle);
    expect(await screen.findByText("Not available for agent patches")).toBeInTheDocument();
  });

  it.each([
    { view: "cumulative" as const, baseline: undefined },
    { view: "since-looked" as const, baseline: 4 },
  ])("rereads $view without whitespace-only files", async ({ view, baseline }) => {
    pickThreadView(view);
    threadAttentionStore.setState({ visitBaselines: { "thread-1": 4 } });
    transport.getCumulativeDiffStats.mockImplementation((_thread: string, _after: number | undefined, options: { ignoreWhitespace?: boolean }) =>
      Promise.resolve(options.ignoreWhitespace ? stats("logic.ts") : stats("logic.ts", "indent.ts")));
    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("indent.ts,logic.ts"));
    await userEvent.setup().click(screen.getByTestId("review-whitespace-toggle"));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent(/^logic\.ts$/));
    expect(transport.getCumulativeDiffStats).toHaveBeenLastCalledWith("thread-1", baseline, { ignoreWhitespace: true });
    expect(screen.getByTestId("diff-files")).toHaveAttribute("data-ignore-whitespace", "true");
  });

  it("offers the whitespace control on a Git-fallback turn", async () => {
    transport.listReviewTurns.mockResolvedValue([turn("msg-1", 1)]);
    transport.getTurnDiffComparison.mockResolvedValue(ready({ files: [file("fallback.ts")], additions: 1, deletions: 0,
      turnDiff: { id: "git:snap-1", phase: "settled", source: "git", fidelity: "same-file-changes-possible", revision: 0 } }));
    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("fallback.ts"));
    await userEvent.setup().click(screen.getByTestId("review-whitespace-toggle"));
    await waitFor(() => expect(transport.getTurnDiffComparison).toHaveBeenLastCalledWith("thread-1", "msg-1", { ignoreWhitespace: true }));
  });

  it.each([false, true])("finishes the first snapshot load so the latest turn can render, failed=%s", async (failed) => {
    useDiffStore.setState({ snapshotsByThread: {} });
    const firstLoad = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReturnValueOnce(firstLoad.promise);
    transport.listReviewTurns.mockResolvedValue([turn("msg-1", 1)]);
    transport.getTurnDiffComparison.mockResolvedValue(comparison("native-1", "agent.ts"));
    render(<DiffPanel />);
    expect(useDiffStore.getState().snapshotsLoadingByThread["thread-1"]).toBe(true);
    if (failed) firstLoad.reject(new Error("Snapshot list unavailable"));
    else firstLoad.resolve([]);
    await waitFor(() => expect(useDiffStore.getState().snapshotsLoadingByThread["thread-1"]).toBe(false));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("agent.ts"));
    expect(transport.getTurnDiffComparison).toHaveBeenCalledWith("thread-1", "msg-1", { ignoreWhitespace: false });
    transport.getTurnDiffComparison.mockResolvedValue(comparison("native-2", "refreshed.ts"));
    await userEvent.setup().click(screen.getByTestId("review-refresh"));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("refreshed.ts"));
  });

  it("keeps the shown turn while following latest until the next turn's diff settles", async () => {
    transport.listReviewTurns.mockResolvedValue([turn("msg-1", 1)]);
    const next = deferred<ReviewComparisonResult>();
    transport.getTurnDiffComparison.mockImplementation((_thread: string, messageId: string) =>
      messageId === "msg-1" ? Promise.resolve(comparison("turn-1", "first.ts")) : next.promise);
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("first.ts"));

    transport.listReviewTurns.mockResolvedValue([turn("msg-1", 1), turn("msg-2", 2, "live")]);
    act(() => { useDiffStore.getState().bumpDiffRevision("thread-1"); });
    await waitFor(() => expect(transport.getTurnDiffComparison).toHaveBeenCalledWith("thread-1", "msg-2", { ignoreWhitespace: false }));
    expect(screen.getByTestId("diff-files")).toHaveTextContent("first.ts");
    expect(screen.queryByTestId("review-state")).not.toBeInTheDocument();

    next.resolve(comparison("turn-2", "second.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("second.ts"));
  });

  it("forwards the picked turn's message id and reloads when it changes", async () => {
    useDiffStore.setState({ selectedTurnByThread: { "thread-1": "msg-picked" } });
    transport.getTurnDiffComparison.mockResolvedValue(comparison("picked-1", "picked.ts"));

    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("picked.ts"));
    expect(transport.getTurnDiffComparison).toHaveBeenCalledWith("thread-1", "msg-picked", { ignoreWhitespace: false });

    transport.getTurnDiffComparison.mockResolvedValue(comparison("picked-2", "other.ts"));
    act(() => { useDiffStore.getState().setReviewTurnForThread("thread-1", "msg-other"); });
    await waitFor(() => expect(transport.getTurnDiffComparison).toHaveBeenCalledWith("thread-1", "msg-other", { ignoreWhitespace: false }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("other.ts"));
  });

  it("never sends an operand-less request while following a thread without turns", async () => {
    render(<DiffPanel />);

    // Operand-less requests resolve live state the user never chose. The
    // panel settles empty without asking the server.
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

  it.each<[number, "docks" | "pops over"]>([[800, "docks"], [799, "pops over"]])(
    "at a %ipx panel the Files tree %s",
    async (width, mode) => {
      measuredWidth = width;
      useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
      useDiffStore.setState({ viewMode: "unstaged" });
      transport.getReviewComparison.mockReset().mockResolvedValue(
        ready({ files: [file("src/a.ts"), file("src/b.ts")], additions: 0, deletions: 0 }),
      );
      render(<DiffPanel />);
      await screen.findByTestId("diff-files");

      await userEvent.click(screen.getByTestId("review-files-toggle"));

      if (mode === "docks") {
        expect(screen.getByTestId("worktree-files")).toHaveTextContent("src/a.ts,src/b.ts");
        expect(screen.queryByTestId("review-files-popover")).not.toBeInTheDocument();
      } else {
        expect(await screen.findByTestId("review-files-popover")).toBeInTheDocument();
        expect(screen.queryByTestId("worktree-files")).not.toBeInTheDocument();
        expect(useDiffStore.getState().reviewFilesVisibleByScope["workspace-1"]).toBeFalsy();
      }
    },
  );

  it("jumps to the picked file and closes the popover", async () => {
    measuredWidth = 536;
    useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
    useDiffStore.setState({ viewMode: "unstaged", reviewFileJumpRequest: null });
    transport.getReviewComparison.mockReset().mockResolvedValue(
      ready({ files: [file("src/a.ts"), file("src/b.ts")], additions: 0, deletions: 0 }),
    );
    render(<DiffPanel />);
    await screen.findByTestId("diff-files");

    await userEvent.click(screen.getByTestId("review-files-toggle"));
    await userEvent.click(await screen.findByRole("treeitem", { name: /b\.ts/ }));

    expect(useDiffStore.getState().reviewFileJumpRequest).toMatchObject({ scopeId: "workspace-1", path: "src/b.ts" });
    await waitFor(() => expect(screen.queryByTestId("review-files-popover")).not.toBeInTheDocument());
  });

  it("closes the popover on Escape", async () => {
    measuredWidth = 536;
    useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
    useDiffStore.setState({ viewMode: "unstaged" });
    transport.getReviewComparison.mockReset().mockResolvedValue(
      ready({ files: [file("src/a.ts")], additions: 0, deletions: 0 }),
    );
    render(<DiffPanel />);
    await screen.findByTestId("diff-files");

    await userEvent.click(screen.getByTestId("review-files-toggle"));
    await screen.findByTestId("review-files-popover");
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("review-files-popover")).not.toBeInTheDocument());
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

    await user.click(screen.getByTestId("review-refresh"));
    await waitFor(() => expect(transport.getReviewComparison).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("review-refresh")).toHaveAccessibleName("Refreshing");

    second.resolve(ready({ files: [file("new.ts")], additions: 2, deletions: 1 }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("new.ts"));
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("new.ts");
    expect(transport.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("refreshes a Commit comparison from the header", async () => {
    transport.getReviewComparison.mockReset().mockResolvedValueOnce({
      status: "failed", failure: { kind: "git-error", summary: "Git reported an error", detail: "fatal" },
    }).mockResolvedValueOnce(stats("fixed.ts"));
    useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
    useDiffStore.setState({ viewMode: "commit", selectedCommitSha: "abc123" });
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));

    await userEvent.setup().click(screen.getByTestId("review-refresh"));

    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("fixed.ts"));
    expect(transport.getReviewComparison).toHaveBeenLastCalledWith(expect.objectContaining({ view: "commit", sha: "abc123" }));
  });

  it("diffs the picked Branch operands as base...compare, with no swap", async () => {
    pickThreadView("branch");
    useDiffStore.setState({
      branchComparison: {
        base: "refs/remotes/origin/main", compare: "refs/heads/feature", isUnborn: false, isComparisonAvailable: true,
      },
      branchComparisonKey: "workspace-1:thread-1",
      branchSelectionByScope: {
        "workspace-1:thread-1": { base: "refs/heads/mcode-3f2a", compare: "refs/remotes/origin/main" },
      },
    });
    transport.getReviewComparison.mockReset().mockResolvedValue(stats("picked.ts"));
    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("picked.ts"));
    expect(transport.getReviewComparison).toHaveBeenLastCalledWith(expect.objectContaining({
      view: "branch", base: "refs/heads/mcode-3f2a", compare: "refs/remotes/origin/main",
    }));
    expect(screen.getByTestId("diff-files")).toHaveAttribute(
      "data-id", expect.stringContaining("refs/heads/mcode-3f2a...refs/remotes/origin/main"),
    );
  });

  it("does not diff another thread's Branch operands while this thread's default resolves", async () => {
    pickThreadView("branch");
    useDiffStore.setState({
      branchComparison: {
        base: "refs/remotes/origin/main", compare: "refs/heads/other", isUnborn: false, isComparisonAvailable: true,
      },
      branchComparisonKey: "workspace-1:thread-other",
      branchSelectionByScope: {
        "workspace-1:thread-other": { base: "refs/heads/main", compare: "refs/heads/other" },
      },
    });
    transport.getReviewComparison.mockReset().mockResolvedValue(stats("other.ts"));
    render(<DiffPanel />);

    await act(async () => {});
    expect(transport.getReviewComparison).not.toHaveBeenCalledWith(expect.objectContaining({ view: "branch" }));
    expect(screen.queryByText("other.ts")).not.toBeInTheDocument();
  });

  it("keeps the Turn diff and Files atomic through refresh success and shows a comparison failure", async () => {
    const turnDiff = gate<ReviewComparisonResult>(transport.getTurnDiffComparison);
    const nextList = deferred<TurnSnapshot[]>();
    const failedList = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReset().mockReturnValueOnce(nextList.promise).mockReturnValueOnce(failedList.promise);
    transport.listReviewTurns.mockResolvedValue([turn("msg-1", 1)]);
    useDiffStore.setState({ snapshotsByThread: { "thread-1": [snapshot("snapshot-old", "old.ts")] } });
    const user = userEvent.setup();

    render(<DiffPanel />);
    turnDiff.resolve(comparison("turn-old", "old.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveAttribute("data-id", "turn-old"));
    act(() => { useDiffStore.getState().setReviewFilesVisible("thread-1", true); });
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    turnDiff.reopen();
    await user.click(screen.getByTestId("review-refresh"));
    nextList.resolve([snapshot("snapshot-next", "next.ts")]);
    await waitFor(() => expect(transport.listSnapshots).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("diff-files")).toHaveAttribute("data-id", "turn-old");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    turnDiff.resolve(comparison("turn-next", "next.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveAttribute("data-id", "turn-next"));
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("next.ts");

    turnDiff.reopen();
    await waitFor(() => expect(screen.getByTestId("review-refresh")).toBeEnabled());
    await user.click(screen.getByTestId("review-refresh"));
    failedList.resolve([snapshot("snapshot-failed", "failed.ts")]);
    turnDiff.reject(new Error("stats failed"));
    // A failed refresh reads as a failure, never as the previous comparison.
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    expect(screen.queryByTestId("diff-files")).not.toBeInTheDocument();
    expect(screen.getByTestId("worktree-files")).not.toHaveTextContent("next.ts");
  });

  it("keeps All turns cache identity, diff, and Files atomic through refresh success and shows a stats failure", async () => {
    const cumulative = gate<ReviewComparisonResult>(transport.getCumulativeDiffStats);
    const nextList = deferred<TurnSnapshot[]>();
    const failedList = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReset().mockReturnValueOnce(nextList.promise).mockReturnValueOnce(failedList.promise);
    pickThreadView("cumulative");
    useDiffStore.setState({ snapshotsByThread: { "thread-1": [snapshot("snapshot-old", "old.ts")] } });
    const user = userEvent.setup();

    render(<DiffPanel />);
    cumulative.resolve(stats("old.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts"));
    act(() => { useDiffStore.getState().setReviewFilesVisible("thread-1", true); });
    const oldVersion = screen.getByTestId("diff-files").getAttribute("data-cache-version");

    cumulative.reopen();
    await user.click(screen.getByTestId("review-refresh"));
    nextList.resolve([snapshot("snapshot-next", "next.ts")]);
    await waitFor(() => expect(transport.getCumulativeDiffStats).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("diff-files")).toHaveAttribute("data-cache-version", oldVersion);
    expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    cumulative.resolve(stats("next.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("next.ts"));
    expect(screen.getByTestId("diff-files")).not.toHaveAttribute("data-cache-version", oldVersion);
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("next.ts");

    cumulative.reopen();
    await user.click(screen.getByTestId("review-refresh"));
    failedList.resolve([snapshot("snapshot-failed", "failed.ts")]);
    await waitFor(() => expect(transport.getCumulativeDiffStats).toHaveBeenCalledTimes(3));
    cumulative.reject(new Error("stats failed"));
    // A failed refresh reads as a failure, never as the previous comparison.
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    expect(screen.queryByTestId("diff-files")).not.toBeInTheDocument();
    expect(screen.getByTestId("worktree-files")).not.toHaveTextContent("next.ts");
  });

  it("ignores an unresolved snapshot refresh after the active scope changes", async () => {
    transport.listReviewTurns.mockResolvedValue([turn("msg-1", 1)]);
    transport.getTurnDiffComparison.mockResolvedValue(comparison("snapshot-old", "old.ts"));
    const oldSnapshot = snapshot("snapshot-old", "old.ts");
    const staleList = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReset().mockReturnValueOnce(staleList.promise);
    useDiffStore.setState({ snapshotsByThread: { "thread-1": [oldSnapshot] } });
    const user = userEvent.setup();

    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts"));
    await user.click(screen.getByTestId("review-refresh"));
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
    useDiffStore.setState({ viewMode: "unstaged" });
    render(<DiffPanel />);
  }

  it("keeps row 2 and Refresh while the comparison loads", async () => {
    useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
    useDiffStore.setState({ viewMode: "unstaged" });
    transport.getReviewComparison.mockReset().mockReturnValue(new Promise(() => {}));
    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("review-refresh")).toHaveAccessibleName("Refreshing"));
    expect(screen.getByTestId("review-controls-row")).toBeInTheDocument();
    expect(screen.queryByTestId("review-state")).not.toBeInTheDocument();
  });

  it.each<[string, ReviewComparisonResult, string, string]>([
    ["empty", EMPTY_READY, "empty", "No unstaged changes"],
    ["too-many-files", { status: "too-many-files", fileCount: 12_345, limit: 10_000 }, "too-many-files", "12,345 changed files. Review shows up to 10,000."],
    ["failed", { status: "failed", failure: { kind: "timeout", summary: "git diff timed out", detail: "stderr" } }, "failed", "git diff timed out"],
    ["unborn", { status: "unavailable", reason: "unborn" }, "empty", "No commits yet"],
    ["snapshot-expired", { status: "unavailable", reason: "snapshot-expired" }, "gone", "Snapshots older than 30 days are cleared"],
  ])("renders the %s outcome as its own body under the full row 2", async (_label, result, kind, text) => {
    renderUnstaged(result);

    const body = await screen.findByTestId("review-state");
    expect(body).toHaveAttribute("data-review-state", kind);
    expect(body).toHaveTextContent(text);
    expect(screen.queryByTestId("diff-files")).not.toBeInTheDocument();
    // Refresh, Expand/Collapse all and Files stay reachable without a file list.
    expect(screen.getByTestId("review-controls-row")).toBeInTheDocument();
    expect(screen.getByTestId("review-refresh")).toBeEnabled();
    expect(screen.getByTestId("review-toggle-all")).toBeInTheDocument();
    expect(screen.getByTestId("review-files-toggle")).toBeEnabled();
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

  it("collapses and expands every file from the header, with its label following", async () => {
    renderUnstaged(stats("a.ts", "b.ts", "c.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("a.ts,b.ts,c.ts"));
    const user = userEvent.setup();
    const toggle = () => screen.getByTestId("review-toggle-all");

    expect(toggle()).toHaveAccessibleName("Collapse all");

    await user.click(toggle());
    expect(useDiffStore.getState().bulkDiffExpand?.expand).toBe(false);
    expect(toggle()).toHaveAccessibleName("Expand all");

    await user.click(toggle());
    expect(useDiffStore.getState().bulkDiffExpand?.expand).toBe(true);
    expect(toggle()).toHaveAccessibleName("Collapse all");
  });

  it("starts All turns collapsed, so its toggle offers Expand all", async () => {
    pickThreadView("cumulative");
    transport.getCumulativeDiffStats.mockResolvedValue(stats("a.ts", "b.ts", "c.ts"));
    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("a.ts"));
    expect(screen.getByTestId("review-toggle-all")).toHaveAccessibleName("Expand all");
  });

  it("loads Since you looked after this visit's baseline, collapsed, and reloads when the baseline moves", async () => {
    pickThreadView("since-looked");
    threadAttentionStore.setState({ visitBaselines: { "thread-1": 4 } });
    transport.getCumulativeDiffStats.mockResolvedValue(stats("a.ts"));
    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("a.ts"));
    expect(screen.getByTestId("diff-files")).toHaveAttribute("data-source", "since-looked");
    expect(screen.getByTestId("diff-files")).toHaveAttribute("data-id", "4");
    expect(transport.getCumulativeDiffStats).toHaveBeenLastCalledWith("thread-1", 4, { ignoreWhitespace: false });
    expect(screen.getByTestId("review-toggle-all")).toHaveAccessibleName("Expand all");

    transport.getCumulativeDiffStats.mockResolvedValue(stats("b.ts"));
    act(() => threadAttentionStore.setState({ visitBaselines: { "thread-1": 8 } }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("b.ts"));
    expect(screen.getByTestId("diff-files")).toHaveAttribute("data-id", "8");
  });

  it("reports a turn list that never loaded and retries the list", async () => {
    transport.listReviewTurns.mockReset().mockRejectedValueOnce(new Error("turns offline")).mockResolvedValueOnce([]);
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

  it("refreshes a turn list that never loaded from the header and pulses while it reloads", async () => {
    const retry = deferred<never[]>();
    transport.listReviewTurns.mockReset().mockRejectedValueOnce(new Error("turns offline")).mockReturnValueOnce(retry.promise);
    const user = userEvent.setup();
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));

    await user.click(screen.getByTestId("review-refresh"));
    await waitFor(() => expect(screen.queryByTestId("review-state")).not.toBeInTheDocument());
    expect(useDiffStore.getState().reviewTurnsErrorByThread["thread-1"]).toBeUndefined();

    await act(async () => { retry.resolve([]); });
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveTextContent("No turns yet"));
  });

  it("retries a picked turn's comparison even when its list never loaded", async () => {
    transport.listReviewTurns.mockReset().mockRejectedValue(new Error("turns offline"));
    transport.getTurnDiffComparison.mockReset()
      .mockResolvedValue({ status: "failed", failure: { kind: "git-error", summary: "Git reported an error", detail: "fatal" } });
    useDiffStore.setState({ selectedTurnByThread: { "thread-1": "msg-picked" } });
    const user = userEvent.setup();
    render(<DiffPanel />);
    await waitFor(() => expect(useDiffStore.getState().reviewTurnsErrorByThread["thread-1"]).toBe("turns offline"));
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveTextContent("Git reported an error"));
    transport.getTurnDiffComparison.mockResolvedValue(comparison("picked-1", "picked.ts"));

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("picked.ts"));
  });

  it("refetches a picked running turn when the worktree changes", async () => {
    const liveTurn = { ...turn("msg-live", 1, "live"), additions: null, deletions: null };
    const live = (path: string, revision: number): ReviewComparisonResult => ready({
      files: [file(path)], additions: 1, deletions: 0,
      turnDiff: { id: `live-${revision}`, phase: "live", source: "native", fidelity: "agent", revision },
    });
    transport.listReviewTurns.mockReset().mockResolvedValue([liveTurn]);
    transport.getTurnDiffComparison.mockReset().mockResolvedValue(live("first.ts", 1));
    useDiffStore.setState({
      selectedTurnByThread: { "thread-1": "msg-live" },
      reviewTurnsByThread: { "thread-1": [liveTurn] },
    });
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("first.ts"));

    transport.getTurnDiffComparison.mockResolvedValue(live("second.ts", 2));
    act(() => { useDiffStore.getState().bumpDiffRevision("thread-1"); });
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("second.ts"));
  });

  it("retries a failed turn comparison, not the list, when a loaded list's refetch failed", async () => {
    transport.listReviewTurns.mockReset().mockRejectedValue(new Error("turns offline"));
    transport.getTurnDiffComparison.mockReset()
      .mockResolvedValue({ status: "failed", failure: { kind: "git-error", summary: "Git reported an error", detail: "fatal" } });
    useDiffStore.setState({
      selectedTurnByThread: { "thread-1": "msg-picked" },
      reviewTurnsByThread: { "thread-1": [] },
    });
    const user = userEvent.setup();
    render(<DiffPanel />);
    await waitFor(() => expect(useDiffStore.getState().reviewTurnsErrorByThread["thread-1"]).toBe("turns offline"));
    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    transport.getTurnDiffComparison.mockResolvedValue(comparison("picked-1", "picked.ts"));

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("picked.ts"));
  });

  it("replaces the shown comparison when a refresh cannot list snapshots", async () => {
    transport.getCumulativeDiffStats.mockReset().mockResolvedValue(stats("old.ts"));
    transport.listSnapshots.mockReset().mockRejectedValueOnce(new Error("snapshots offline"));
    pickThreadView("cumulative");
    useDiffStore.setState({ snapshotsByThread: { "thread-1": [snapshot("snapshot-old", "old.ts")] } });
    const user = userEvent.setup();
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts"));

    await user.click(screen.getByTestId("review-refresh"));

    await waitFor(() => expect(screen.getByTestId("review-state")).toHaveAttribute("data-review-state", "failed"));
    expect(screen.queryByTestId("diff-files")).not.toBeInTheDocument();
    expect(screen.getByTestId("review-refresh")).toBeEnabled();
    transport.listSnapshots.mockResolvedValue([snapshot("snapshot-old", "old.ts")]);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts"));
  });

  it("keeps a newer comparison when an older refresh fails late", async () => {
    transport.getCumulativeDiffStats.mockReset().mockResolvedValue(stats("old.ts"));
    const lateList = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReset().mockReturnValueOnce(lateList.promise);
    pickThreadView("cumulative");
    useDiffStore.setState({ snapshotsByThread: { "thread-1": [snapshot("snapshot-old", "old.ts")] } });
    const user = userEvent.setup();
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts"));

    await user.click(screen.getByTestId("review-refresh"));
    transport.getCumulativeDiffStats.mockResolvedValue(stats("new.ts"));
    act(() => {
      useDiffStore.getState().setSnapshots("thread-1", [snapshot("snapshot-old", "old.ts"), snapshot("snapshot-new", "new.ts")]);
    });
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("new.ts"));

    await act(async () => { lateList.reject(new Error("snapshots offline")); });
    expect(screen.getByTestId("diff-files")).toHaveTextContent("new.ts");
    expect(screen.queryByTestId("review-state")).not.toBeInTheDocument();
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
