import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { ThreadOverview } from "@/components/chat/ThreadOverview";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resetThreadRecapRequestStateForTest } from "@/hooks/useThreadRecap";
import { rightPanelSingletonId, useDiffStore } from "@/stores/diffStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { usePlanStore } from "@/stores/planStore";
import { useTaskStore, type TaskItem } from "@/stores/taskStore";
import { createEmptyThreadRecord, patchThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import type { PlanVersion } from "@mcode/contracts/models/plan";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => mockTransport,
}));

const thread = createMockThread({ id: "rows-thread", workspace_id: "rows-workspace", provider: "cursor" });

function readyComparison(additions: number, deletions: number) {
  return {
    status: "ready" as const,
    comparison: {
      files: [{ path: "src/a.ts", previousPath: null, changeType: "modified" as const, binary: false, additions, deletions, untracked: false }],
      additions,
      deletions,
    },
  };
}

function patchRecord(patch: Partial<ThreadRecord>) {
  useThreadStore.setState((state) => ({ records: patchThreadRecord(state.records, thread.id, patch) }));
}

function setRunning(running: boolean) {
  useThreadStore.setState({ runningThreadIds: running ? new Set([thread.id]) : new Set() });
}

function setLiveFileEffects(additions: number, deletions: number) {
  patchRecord({ fileEffectSummary: { revision: additions + deletions, fileCount: 1, additions, deletions, effects: [] } });
}

function changeSummaryRpcCount() {
  return vi.mocked(mockTransport.getReviewComparison).mock.calls.length
    + vi.mocked(mockTransport.getSnapshotDiffStats).mock.calls.length
    + vi.mocked(mockTransport.listSnapshots).mock.calls.length;
}

async function flushTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function planVersion(version: number): PlanVersion {
  return {
    id: `plan-${version}`, threadId: thread.id, messageId: `message-${version}`, version,
    title: "Tidy thread actions menu", contentMd: "# Tidy thread actions menu",
    status: "ready", author: "agent", providerId: "cursor", captureSource: "fence", baseVersionId: null,
    revision: 0, acceptedAt: null, acceptedMessageId: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function task(id: string, status: TaskItem["status"]): TaskItem {
  return { id, content: `Task ${id}`, status, group: "Tasks" };
}

describe("overview Changes, Tasks and Usage rows", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    resetThreadRecapRequestStateForTest();
    vi.mocked(mockTransport.getRemoteUrl).mockResolvedValue({ label: "example/repo", webUrl: null });
    vi.mocked(mockTransport.getReviewComparison).mockReset().mockResolvedValue(readyComparison(4, 9));
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
    useThreadStore.setState({
      records: new Map([[thread.id, createEmptyThreadRecord()]]),
      recapByThread: {},
      runningThreadIds: new Set(),
    });
    useTaskStore.setState({ taskBubbleByThread: {}, tasksByThread: {}, trayExpandedByThread: {} });
    usePlanStore.setState({ plansByThread: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows live file effects while a turn runs and sends no change RPC for file writes", async () => {
    setRunning(true);
    setLiveFileEffects(12, 9);
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    for (let write = 0; write < 5; write += 1) {
      act(() => useDiffStore.getState().bumpDiffRevision(thread.id));
      await flushTimers(100);
    }
    act(() => setLiveFileEffects(15, 9));
    await flushTimers(1_000);

    expect(changeSummaryRpcCount()).toBe(0);
    const summary = screen.getByTestId("thread-overview-change-summary");
    expect(summary).toHaveTextContent("+15 −9");
    expect(summary).toHaveAttribute("aria-label", "15 additions, 9 deletions");
  });

  it("resolves the change summary once after the turn settles, despite a burst of file events", async () => {
    setRunning(true);
    setLiveFileEffects(12, 9);
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await flushTimers(500);

    act(() => setRunning(false));
    for (let write = 0; write < 3; write += 1) {
      act(() => useDiffStore.getState().bumpDiffRevision(thread.id));
      await flushTimers(50);
    }
    expect(screen.queryByTestId("thread-overview-change-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-change-summary")).toHaveTextContent("+12 −9");

    await flushTimers(1_000);
    expect(mockTransport.getReviewComparison).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("thread-overview-change-summary")).toHaveTextContent("+4 −9");
  });

  it("resolves once on settle when the snapshot cache starts empty", async () => {
    useDiffStore.setState({ snapshotsByThread: {} });
    vi.mocked(mockTransport.listSnapshots).mockResolvedValue([]);
    setRunning(true);
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await flushTimers(500);

    act(() => setRunning(false));
    await flushTimers(2_000);

    expect(mockTransport.getReviewComparison).toHaveBeenCalledTimes(1);
  });

  it("hides the Changes row when there are no changes", async () => {
    vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({
      status: "ready",
      comparison: { files: [], additions: 0, deletions: 0 },
    });
    vi.mocked(mockTransport.getReviewState).mockResolvedValue({
      isGitRepo: true, head: "abc", branch: "main",
      uncommitted: { staged: 0, unstaged: 0, untracked: 0 },
      commitsAhead: null, branchDefault: { base: "main" },
    } as Awaited<ReturnType<typeof mockTransport.getReviewState>>);
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await flushTimers(1_000);

    expect(mockTransport.getReviewComparison).toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-menu-changes")).not.toBeInTheDocument();
  });

  it("does not show the Changes row while a turn-end load with no known changes is pending", async () => {
    let resolveComparison: (value: ReturnType<typeof readyComparison>) => void = () => {};
    vi.mocked(mockTransport.getReviewComparison).mockReturnValue(new Promise((resolve) => { resolveComparison = resolve; }));
    setRunning(true);
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await flushTimers(100);

    act(() => setRunning(false));
    await flushTimers(1_500);
    expect(mockTransport.getReviewComparison).toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-menu-changes")).not.toBeInTheDocument();

    await act(async () => resolveComparison(readyComparison(2, 1)));
    expect(screen.getByTestId("thread-overview-change-summary")).toHaveTextContent("+2 −1");
  });

  it("keeps the Changes row for a change without line totals", async () => {
    vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({
      status: "ready",
      comparison: {
        files: [{ path: "logo.png", previousPath: null, changeType: "modified", binary: true, additions: 0, deletions: 0, untracked: false }],
        additions: 0,
        deletions: 0,
      },
    });
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await flushTimers(1_000);

    expect(screen.getByTestId("workspace-menu-changes")).toHaveAttribute("aria-label", "Changes, 1 file");
    expect(screen.queryByTestId("thread-overview-change-summary")).not.toBeInTheDocument();
  });

  it("does not re-render the overview for streaming text deltas", async () => {
    setRunning(true);
    setLiveFileEffects(3, 1);
    let commits = 0;
    render(
      <Profiler id="overview" onRender={() => { commits += 1; }}>
        <ThreadOverview thread={thread} threadPaneWidth={1400} />
      </Profiler>,
    );
    await flushTimers(1_000);
    const settledCommits = commits;

    let streaming = "";
    for (let delta = 0; delta < 20; delta += 1) {
      streaming += `token ${delta} `;
      act(() => patchRecord({ streaming, streamingPreview: streaming.slice(-200), responseTextIsStreaming: true }));
    }
    await flushTimers(100);

    expect(commits).toBe(settledCommits);
  });

  it("titles the Tasks row from the implemented plan and opens the composer tray list", async () => {
    useTaskStore.getState().setTasks(
      thread.id,
      [task("1", "completed"), task("2", "completed"), task("3", "cancelled"), task("4", "in_progress")],
      "accepted-message",
    );
    usePlanStore.setState({
      plansByThread: {
        [thread.id]: [{ title: "Tidy thread actions menu", acceptedMessageId: "accepted-message" } as PlanVersion],
      },
    });
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const row = screen.getByTestId("thread-overview-tasks");
    expect(row).toHaveTextContent("Tidy thread actions menu");
    expect(row).toHaveTextContent("3/4");
    expect(row).not.toHaveTextContent(thread.title);
    expect(screen.queryByText("Plans")).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(useTaskStore.getState().trayExpandedByThread[thread.id]).toBe(true);
  });

  it("titles a task list without a plan as Tasks and hides the row without tasks", () => {
    const { unmount } = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    expect(screen.queryByTestId("thread-overview-tasks")).not.toBeInTheDocument();
    unmount();

    useTaskStore.getState().setTasks(thread.id, [task("1", "pending"), task("2", "completed")], null);
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    expect(screen.getByTestId("thread-overview-tasks")).toHaveTextContent("Tasks1/2");
  });

  it("shows the plan row only with a version and opens the Plan tab in place of the docked card", () => {
    const { unmount } = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    expect(screen.queryByTestId("thread-overview-plan")).not.toBeInTheDocument();
    unmount();

    usePlanStore.setState({ plansByThread: { [thread.id]: [planVersion(1), planVersion(2)] } });
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    const row = screen.getByTestId("thread-overview-plan");
    expect(row).toHaveTextContent("Tidy thread actions menu");
    expect(row).toHaveTextContent("v2");
    expect(row).toHaveAccessibleName("Open plan Tidy thread actions menu, version 2");

    fireEvent.click(row);

    const panel = useDiffStore.getState().getRightPanel(thread.workspace_id, thread.id);
    expect(panel.visible).toBe(true);
    expect(panel.activeTabId).toBe(rightPanelSingletonId("tasks"));
    expect(screen.queryByTestId("thread-overview-plan")).not.toBeInTheDocument();
  });

  it("shows the Implement turn's task progress on an accepted plan row", () => {
    const accepted = { ...planVersion(2), status: "accepted" as const, acceptedMessageId: "accepted-message" };
    usePlanStore.setState({ plansByThread: { [thread.id]: [accepted] } });
    useTaskStore.getState().setTasks(thread.id, [task("1", "completed"), task("2", "in_progress")], "other-message");
    const { unmount } = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    expect(screen.getByTestId("thread-overview-plan")).toHaveTextContent("v2");
    unmount();

    useTaskStore.getState().setTasks(thread.id, [task("1", "completed"), task("2", "in_progress")], "accepted-message");
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    expect(screen.getByTestId("thread-overview-plan")).toHaveTextContent("1/2");
    expect(screen.getByTestId("thread-overview-plan"))
      .toHaveAccessibleName("Open plan Tidy thread actions menu, version 2, 1 of 2 tasks done");
  });

  it("keeps the implemented plan's progress on the row after a newer draft supersedes it", () => {
    const accepted = { ...planVersion(2), status: "accepted" as const, acceptedMessageId: "accepted-message" };
    const newer = { ...planVersion(3), status: "draft" as const, title: "Next plan" };
    usePlanStore.setState({ plansByThread: { [thread.id]: [accepted, newer] } });
    useTaskStore.getState().setTasks(thread.id, [task("1", "completed"), task("2", "in_progress")], "accepted-message");
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const row = screen.getByTestId("thread-overview-plan");
    expect(row).toHaveTextContent("Tidy thread actions menu");
    expect(row).toHaveTextContent("1/2");
  });
});
