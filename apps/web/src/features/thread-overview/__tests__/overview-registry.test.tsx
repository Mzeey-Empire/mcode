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
  vi.mocked(mockTransport.getWorkingTreeFiles).mockResolvedValue([
    "src/example.ts",
  ]);
  vi.mocked(mockTransport.getReviewDiffStats).mockResolvedValue({ additions: 7, deletions: 2 });
  vi.mocked(mockTransport.getRemoteUrl).mockResolvedValue({ label: "example/repo", webUrl: "https://github.com/example/repo" });
}

async function closeOverview() {
  fireEvent.click(screen.getByTestId("header-workspace-menu"));
  await waitFor(() => expect(screen.queryByTestId("thread-overview-body")).not.toBeInTheDocument());
}

describe("overview registry", () => {
  const thread = createMockThread({ id: "overview-thread", workspace_id: "overview-workspace", provider: "cursor" });
  const subject: OverviewSubject = { kind: "thread", thread };

  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadRecapRequestStateForTest();
    vi.mocked(mockTransport.getWorkingTreeFiles).mockReset().mockResolvedValue([]);
    vi.mocked(mockTransport.getRemoteUrl).mockReset().mockResolvedValue({ label: "test-project", webUrl: null });
    vi.mocked(mockTransport.getReviewDiffStats).mockReset().mockResolvedValue({ additions: 0, deletions: 0 });
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: thread.workspace_id })],
      threads: [thread],
      prUrlsByThreadId: {},
      checksById: {},
    });
    useOverviewStore.setState({ reserveThreadId: null, requestedThreadId: null });
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

  it("renders the direct-thread rows in their existing DOM order without empty-row separators", async () => {
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await waitFor(() => expect(mockTransport.getRemoteUrl).toHaveBeenCalledWith(thread.workspace_id, thread.id));
    const body = screen.getByTestId("thread-overview-body");
    const rowIds = Array.from(body.querySelectorAll("[data-testid]"), element => element.getAttribute("data-testid"))
      .filter(id => ["thread-overview-masthead", "thread-overview-masthead-controls", "workspace-menu-changes", "thread-overview-local", "workspace-menu-branch", "thread-overview-recap"].includes(id ?? ""));
    expect(rowIds).toEqual([
      "thread-overview-masthead", "thread-overview-masthead-controls", "workspace-menu-changes",
      "thread-overview-local", "workspace-menu-branch", "thread-overview-recap",
    ]);
    expect(screen.queryByTestId("thread-overview-pr-separator")).not.toBeInTheDocument();
    expect(body.querySelectorAll('[data-slot="separator"]')).toHaveLength(2);
  });

  it("shows loaded Changes and repository results on reopen while refreshing them silently", async () => {
    mockLoadedEntries();
    render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
    expect(mockTransport.getWorkingTreeFiles).not.toHaveBeenCalled();
    expect(mockTransport.getRemoteUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    await waitFor(() => expect(screen.getByTestId("thread-overview-change-summary"))
      .toHaveAttribute("aria-label", "7 additions, 2 deletions"));
    expect(screen.getByText("example/repo")).toBeInTheDocument();
    expect(mockTransport.getWorkingTreeFiles).toHaveBeenCalledTimes(1);
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(1);

    await closeOverview();
    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    expect(screen.queryByTestId("thread-overview-change-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-change-summary"))
      .toHaveAttribute("aria-label", "7 additions, 2 deletions");
    expect(screen.getByText("example/repo")).toBeInTheDocument();
    await waitFor(() => expect(mockTransport.getWorkingTreeFiles).toHaveBeenCalledTimes(2));
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(2);
  });

  it("loads project actions once and keeps them across a popover close and reopen", async () => {
    render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    await screen.findByTestId("thread-overview-masthead-controls");
    await waitFor(() => expect(mockTransport.readWorkspaceEnvironment).toHaveBeenCalledTimes(1));
    await closeOverview();
    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    await screen.findByTestId("thread-overview-masthead-controls");
    expect(mockTransport.readWorkspaceEnvironment).toHaveBeenCalledTimes(1);
    expect(mockTransport.listWorkspaceActionRuns).toHaveBeenCalledTimes(1);
  });

  it("lists browser tabs once and stays subscribed while the popover is closed", async () => {
    const off = vi.fn();
    const tabs = {
      list: vi.fn().mockResolvedValue({ ok: false }),
      onUpdated: vi.fn().mockReturnValue(off),
    };
    vi.stubGlobal("desktopBridge", { preview: { tabs } });
    try {
      render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
      expect(screen.queryByTestId("thread-overview-body")).not.toBeInTheDocument();
      expect(tabs.list).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("header-workspace-menu"));
      await screen.findByTestId("thread-overview-body");
      await closeOverview();
      fireEvent.click(screen.getByTestId("header-workspace-menu"));
      await screen.findByTestId("thread-overview-body");
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
    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    await screen.findByText("example/repo");
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(2);
  });

  it.each(["revision", "snapshot"])("reloads Changes after a %s change, only when reopened", async (invalidation) => {
    mockLoadedEntries();
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await screen.findByTestId("thread-overview-change-summary");
    await closeOverview();
    vi.mocked(mockTransport.getReviewDiffStats).mockResolvedValue({ additions: 11, deletions: 3 });
    vi.mocked(mockTransport.getSnapshotDiffStats).mockResolvedValue([
      { filePath: "src/example.ts", additions: 11, deletions: 3, changeType: "modified" },
    ]);
    act(() => {
      if (invalidation === "revision") {
        useDiffStore.getState().bumpDiffRevision(thread.id);
      } else {
        useDiffStore.getState().setSnapshots(thread.id, [{
          id: "new-snapshot", thread_id: thread.id, message_id: "message",
          ref_before: "before", ref_after: "after", files_changed: ["src/example.ts"],
          worktree_path: null, created_at: "2026-10-08T12:00:00Z",
        }]);
      }
    });
    expect(mockTransport.getReviewDiffStats).toHaveBeenCalledTimes(1);
    expect(mockTransport.getSnapshotDiffStats).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    expect(screen.getByTestId("thread-overview-change-loading")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("thread-overview-change-summary"))
      .toHaveAttribute("aria-label", "11 additions, 3 deletions"));
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(2);
    expect(mockTransport.getReviewDiffStats).toHaveBeenCalledTimes(invalidation === "revision" ? 2 : 1);
    expect(mockTransport.getSnapshotDiffStats).toHaveBeenCalledTimes(invalidation === "snapshot" ? 1 : 0);
  });

  it("does not reuse another thread's loaded results", async () => {
    mockLoadedEntries();
    const { rerender } = render(<ThreadOverview thread={thread} threadPaneWidth={600} />);
    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    await screen.findByTestId("thread-overview-change-summary");
    await closeOverview();
    const nextThread = createMockThread({ ...thread, id: "next-thread" });
    vi.mocked(mockTransport.getReviewDiffStats).mockResolvedValue({ additions: 19, deletions: 5 });
    vi.mocked(mockTransport.getRemoteUrl).mockResolvedValue({ label: "example/next", webUrl: "https://github.com/example/next" });
    act(() => useDiffStore.getState().setSnapshots(nextThread.id, []));
    rerender(<ThreadOverview thread={nextThread} threadPaneWidth={600} />);
    expect(mockTransport.getRemoteUrl).toHaveBeenCalledTimes(1);
    expect(mockTransport.getWorkingTreeFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    expect(screen.getByTestId("thread-overview-change-loading")).toBeInTheDocument();
    expect(screen.queryByText("example/repo")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("thread-overview-change-summary"))
      .toHaveAttribute("aria-label", "19 additions, 5 deletions"));
    expect(screen.getByText("example/next")).toBeInTheDocument();
    expect(mockTransport.getWorkingTreeFiles).toHaveBeenLastCalledWith(thread.workspace_id, false, nextThread.id);
    expect(mockTransport.getRemoteUrl).toHaveBeenLastCalledWith(thread.workspace_id, nextThread.id);
  });

  it("keeps a pending Recap and its eventual error across popover unmounts", async () => {
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
    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    expect(screen.getByTestId("thread-overview-recap-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-recap-refresh")).toBeDisabled();

    await closeOverview();
    await act(async () => { rejectRequest(new Error("Recap request failed")); });
    fireEvent.click(screen.getByTestId("header-workspace-menu"));
    expect(screen.queryByTestId("thread-overview-recap-skeleton")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-recap-text")).toHaveTextContent("Recap unavailable");
    expect(screen.getByTestId("thread-overview-recap-refresh")).toBeEnabled();
    expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
  });
});
