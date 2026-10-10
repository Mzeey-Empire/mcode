import { createMockMessage, createMockThread, createMockWorkspace, mockTransport } from "@/__tests__/mocks/transport";
import { ThreadOverview } from "@/components/chat/ThreadOverview";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { resetThreadRecapRequestStateForTest } from "@/hooks/useThreadRecap";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOverviewEntries,
  getOverviewHeaderActions,
  OVERVIEW_ENTRIES,
  OVERVIEW_HEADER_ACTIONS,
} from "../overview-registry";
import type { OverviewSubject } from "../overview-subject";

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => mockTransport,
}));

function mockLoadedEntries() {
  vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({ status: "ready", comparison: { files: [{ path: "src/example.ts", previousPath: null, changeType: "added", binary: false, additions: null, deletions: null, untracked: true }], additions: 7, deletions: 2 } });
  vi.mocked(mockTransport.getRemoteUrl).mockResolvedValue({ label: "example/repo", webUrl: "https://github.com/example/repo" });
}

async function closeOverview() {
  fireEvent.click(screen.getByTestId("header-overview-toggle"));
  await waitFor(() => expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument());
}

describe("overview registry", () => {
  const thread = createMockThread({ id: "overview-thread", workspace_id: "overview-workspace", provider: "cursor" });
  const subject: OverviewSubject = { kind: "thread", thread };

  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadRecapRequestStateForTest();
    vi.mocked(mockTransport.getRemoteUrl).mockReset().mockResolvedValue({ label: "test-project", webUrl: null });
    vi.mocked(mockTransport.getReviewComparison).mockReset().mockResolvedValue({ status: "ready", comparison: { files: [{ path: "src/example.ts", previousPath: null, changeType: "added", binary: false, additions: null, deletions: null, untracked: true }], additions: 0, deletions: 0 } });
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: thread.workspace_id })],
      threads: [thread],
      prUrlsByThreadId: {},
      checksById: {},
    });
    useOverviewStore.setState({ closedSubjects: new Set(), overlaySubject: null, requestedSubject: null });
    useDiffStore.setState({
      rightPanelByThread: {}, rightPanelFallbackByWorkspace: {},
      snapshotsByThread: { [thread.id]: [] }, diffRevisionByScope: {},
    });
    useThreadStore.setState({ records: new Map([[thread.id, createEmptyThreadRecord()]]), recapByThread: {} });
  });

  it("orders thread entries globally, retaining section metadata for the later shell", () => {
    expect(getOverviewEntries(subject).map(({ id, section, order }) => [id, section, order])).toEqual([
      ["setup", "lane", 0],
      ["save-recovery", "activity", 10],
      ["changes", "activity", 20],
      ["repository", "activity", 30],
      ["plans", "activity", 40],
      ["local", "lane", 50],
      ["create-branch", "lane", 60],
      ["branch", "lane", 70],
      ["commit", "lane", 80],
      ["usage", "summary", 90],
      ["subagents", "activity", 100],
      ["pull-request", "lane", 110],
      ["browser", "activity", 120],
      ["sources", "activity", 130],
      ["recap", "summary", 140],
    ]);
    expect(getOverviewHeaderActions(subject).map(({ id }) => id)).toEqual(["project-actions", "settings"]);
  });

  it("excludes every existing entry and header action from a new-thread subject", () => {
    const newThread: OverviewSubject = { kind: "new-thread", workspaceId: thread.workspace_id };
    expect(getOverviewEntries(newThread).map(({ id }) => id)).toEqual([]);
    expect(getOverviewHeaderActions(newThread).map(({ id }) => id)).toEqual([]);
    const { container } = render(<>
      {OVERVIEW_ENTRIES.map(({ id, Entry }) => <Entry key={id} subject={newThread} />)}
      {OVERVIEW_HEADER_ACTIONS.map(({ id, Action }) => <Action key={id} subject={newThread} />)}
    </>);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the direct-thread rows grouped by section under the header", async () => {
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await waitFor(() => expect(mockTransport.getRemoteUrl).toHaveBeenCalledWith(thread.workspace_id, thread.id));
    const card = screen.getByTestId("thread-overview-card");
    const rowIds = Array.from(card.querySelectorAll("[data-testid]"), element => element.getAttribute("data-testid"))
      .filter(id => ["thread-overview-card-header", "workspace-menu-changes", "thread-overview-local", "workspace-menu-branch", "thread-overview-recap"].includes(id ?? ""));
    expect(rowIds).toEqual([
      "thread-overview-card-header", "thread-overview-local", "workspace-menu-branch",
      "workspace-menu-changes", "thread-overview-recap",
    ]);
  });

  it("opens an overlay from the button where the card cannot dock, and Escape closes it", async () => {
    render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    expect(await screen.findByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "overlay");
    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument());
    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("closes the overlay on an outside press but not on the button's own press", async () => {
    render(<><ThreadOverview thread={thread} threadPaneWidth={600} /><button type="button">outside</button></>);
    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    await screen.findByTestId("thread-overview-card");

    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    await waitFor(() => expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    const card = await screen.findByTestId("thread-overview-card");
    act(() => card.closest<HTMLElement>("[role=dialog]")?.focus());
    // A real mouse press moves focus out of the overlay, and Base UI's deferred focus-out settles
    // before the click lands. The click carries a nonzero detail, unlike a synthetic one.
    const outside = screen.getByText("outside");
    fireEvent.pointerDown(outside, { button: 0 });
    fireEvent.mouseDown(outside, { button: 0 });
    await act(async () => {
      outside.focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(outside, { button: 0, detail: 1 });
    await waitFor(() => expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument());
  });

  it("shows loaded Changes and repository results on reopen while refreshing them silently", async () => {
    mockLoadedEntries();
    render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
    expect(mockTransport.getReviewComparison).not.toHaveBeenCalled();
    expect(mockTransport.getRemoteUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    await waitFor(() => expect(screen.getByTestId("thread-overview-change-summary"))
      .toHaveAttribute("aria-label", "7 additions, 2 deletions"));
    expect(screen.getByText("example/repo")).toBeInTheDocument();
    expect(mockTransport.getReviewComparison).toHaveBeenCalledTimes(1);
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(1);

    await closeOverview();
    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    expect(screen.queryByTestId("thread-overview-change-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-change-summary"))
      .toHaveAttribute("aria-label", "7 additions, 2 deletions");
    expect(screen.getByText("example/repo")).toBeInTheDocument();
    await waitFor(() => expect(mockTransport.getReviewComparison).toHaveBeenCalledTimes(2));
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(2);
  });

  it("loads project actions once and keeps them across a close and reopen", async () => {
    render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    await screen.findByTestId("thread-overview-card-header");
    await waitFor(() => expect(mockTransport.readWorkspaceEnvironment).toHaveBeenCalledTimes(1));
    await closeOverview();
    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    await screen.findByTestId("thread-overview-card-header");
    expect(mockTransport.readWorkspaceEnvironment).toHaveBeenCalledTimes(1);
    expect(mockTransport.listWorkspaceActionRuns).toHaveBeenCalledTimes(1);
  });

  it("lists browser tabs once and stays subscribed while the card is closed", async () => {
    const off = vi.fn();
    const tabs = {
      list: vi.fn().mockResolvedValue({ ok: false }),
      onUpdated: vi.fn().mockReturnValue(off),
    };
    vi.stubGlobal("desktopBridge", { preview: { tabs } });
    try {
      render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
      expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
      expect(tabs.list).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("header-overview-toggle"));
      await screen.findByTestId("thread-overview-card");
      await closeOverview();
      fireEvent.click(screen.getByTestId("header-overview-toggle"));
      await screen.findByTestId("thread-overview-card");
      expect(tabs.list).toHaveBeenCalledTimes(1);
      expect(tabs.onUpdated).toHaveBeenCalledTimes(1);
      expect(off).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries a failed repository load on reopen", async () => {
    mockLoadedEntries();
    vi.mocked(mockTransport.getRemoteUrl).mockRejectedValueOnce(new Error("Remote unavailable"));
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await screen.findByTestId("thread-overview-change-summary");
    expect(screen.queryByTestId("thread-overview-repository")).not.toBeInTheDocument();
    await closeOverview();
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    await screen.findByText("example/repo");
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(2);
  });

  it.each(["revision", "snapshot"])("reloads Changes after a %s change, only when reopened", async (invalidation) => {
    mockLoadedEntries();
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await screen.findByTestId("thread-overview-change-summary");
    await closeOverview();
    vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({ status: "ready", comparison: { files: [{ path: "src/example.ts", previousPath: null, changeType: "added", binary: false, additions: null, deletions: null, untracked: true }], additions: 11, deletions: 3 } });
    vi.mocked(mockTransport.getSnapshotDiffStats).mockResolvedValue([
      { filePath: "src/example.ts", additions: 11, deletions: 3, changeType: "modified" },
    ]);
    act(() => {
      if (invalidation === "revision") {
        useDiffStore.getState().bumpDiffRevision(thread.id);
      } else {
        useDiffStore.getState().setSnapshots(thread.id, [{
          id: "new-snapshot", thread_id: thread.id, message_id: "message",
          ref_before: "before", ref_after: "after", attempt_count: 1, files_changed: ["src/example.ts"],
          worktree_path: null, created_at: "2026-10-08T12:00:00Z",
        }]);
      }
    });
    expect(mockTransport.getReviewComparison).toHaveBeenCalledTimes(1);
    expect(mockTransport.getSnapshotDiffStats).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    expect(screen.getByTestId("thread-overview-change-loading")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("thread-overview-change-summary"))
      .toHaveAttribute("aria-label", "11 additions, 3 deletions"));
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(2);
    expect(mockTransport.getReviewComparison).toHaveBeenCalledTimes(invalidation === "revision" ? 2 : 1);
    expect(mockTransport.getSnapshotDiffStats).toHaveBeenCalledTimes(invalidation === "snapshot" ? 1 : 0);
  });

  it("does not reuse another thread's loaded results", async () => {
    mockLoadedEntries();
    const { rerender } = render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    await screen.findByTestId("thread-overview-change-summary");
    await closeOverview();
    const nextThread = createMockThread({ ...thread, id: "next-thread" });
    vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({ status: "ready", comparison: { files: [{ path: "src/example.ts", previousPath: null, changeType: "added", binary: false, additions: null, deletions: null, untracked: true }], additions: 19, deletions: 5 } });
    vi.mocked(mockTransport.getRemoteUrl).mockResolvedValue({ label: "example/next", webUrl: "https://github.com/example/next" });
    act(() => useDiffStore.getState().setSnapshots(nextThread.id, []));
    rerender(<ThreadOverview thread={nextThread} threadPaneWidth={600} />);
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(1);
    expect(mockTransport.getReviewComparison).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    expect(screen.getByTestId("thread-overview-change-loading")).toBeInTheDocument();
    expect(screen.queryByText("example/repo")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("thread-overview-change-summary"))
      .toHaveAttribute("aria-label", "19 additions, 5 deletions"));
    expect(screen.getByText("example/next")).toBeInTheDocument();
    expect(mockTransport.getReviewComparison).toHaveBeenLastCalledWith({ workspaceId: thread.workspace_id, view: "uncommitted", threadId: nextThread.id });
    expect(mockTransport.getRemoteUrl).toHaveBeenLastCalledWith(thread.workspace_id, nextThread.id);
  });

  it("keeps a pending Recap and its eventual error across card unmounts", async () => {
    let rejectRequest: (reason: Error) => void;
    const request = new Promise<{ text: string }>((_resolve, reject) => { rejectRequest = reject; });
    vi.mocked(mockTransport.generateRecap).mockReturnValueOnce(request);
    const record = createEmptyThreadRecord();
    record.messages = [createMockMessage({ thread_id: thread.id, content: "Summarise this thread" })];
    useThreadStore.setState({ records: new Map([[thread.id, record]]) });
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    fireEvent.click(screen.getByTestId("thread-overview-recap-refresh"));
    expect(screen.getByTestId("thread-overview-recap-skeleton")).toBeInTheDocument();
    await closeOverview();
    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    expect(screen.getByTestId("thread-overview-recap-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-recap-refresh")).toBeDisabled();

    await closeOverview();
    await act(async () => { rejectRequest(new Error("Recap request failed")); });
    fireEvent.click(screen.getByTestId("header-overview-toggle"));
    expect(screen.queryByTestId("thread-overview-recap-skeleton")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-recap-text")).toHaveTextContent("Recap unavailable");
    expect(screen.getByTestId("thread-overview-recap-refresh")).toBeEnabled();
    expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
  });
});
