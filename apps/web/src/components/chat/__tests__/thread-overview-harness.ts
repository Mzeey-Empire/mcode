import { vi } from "vitest";
import type { GitRef, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import type { Thread } from "@/transport";
import { useOverviewStore } from "@/stores/overviewStore";
import { useBrowserAutomationStore } from "@/features/preview";
import { usePreviewTabsStore } from "@/features/preview/state/previewTabsStore";
import { useDiffStore } from "@/stores/diffStore";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { setLayoutMeasurements } from "@/lib/composer-layout";
import { useSubagentRosterStore } from "@/features/subagents/state/subagentRosterStore";
import { invalidateBranchTargets } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import {
  mockGetRightPanelVisible,
  mockOpenSubagentsPanel,
  mockThreadRecords,
  mockWorkspaceState,
} from "./thread-overview-mocks";

/** A managed New worktree Thread on a branchless checkout of `main`. */
export function branchlessThread(overrides: Partial<Thread> = {}): Thread {
  return createMockThread({
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Branchless",
    mode: "worktree",
    worktree_path: "/repo/.worktrees/branchless",
    checkout_state: "branchless",
    base_branch: "main",
    worktree_managed: true,
    ...overrides,
  });
}

/** A local branch ref with stable defaults. */
export function gitRef(shortName: string, overrides: Partial<GitRef> = {}): GitRef {
  return {
    kind: "ref",
    fullName: `refs/heads/${shortName}`,
    shortName,
    branchName: shortName,
    remote: null,
    twin: null,
    isCurrent: false,
    isDefault: false,
    worktree: null,
    headSha: "a".repeat(40),
    committedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A complete single page of `listRefs` results. */
export function refsPage(items: GitRef[]) {
  return { ok: true as const, items, total: items.length, nextCursor: null };
}

function runningActionRun(): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "ws-1",
    actionId: "success",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "terminal-1",
    trigger: "manual",
    port: null,
    actionName: "Success",
    status: "running",
    snapshot: {
      platform: "windows",
      script: "bun run success",
      checkoutPath: "C:\\repo",
      terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run success"] },
      environmentNames: ["PATH"],
    },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: null,
    exitCode: null,
  };
}

function resetTransport(): void {
  vi.mocked(mockTransport.createBranch).mockReset().mockResolvedValue({ branch: "feat/issue-801" });
  vi.mocked(mockTransport.listSnapshots).mockReset().mockResolvedValue([]);
  vi.mocked(mockTransport.getReviewComparison).mockReset().mockResolvedValue({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
  vi.mocked(mockTransport.getReviewState).mockReset().mockResolvedValue({ isGitRepo: false });
  vi.mocked(mockTransport.listRefs).mockReset().mockResolvedValue(refsPage([
    gitRef("main", { isCurrent: true, isDefault: true }),
    gitRef("feature/other"),
    gitRef("origin/other", { fullName: "refs/remotes/origin/other", branchName: "other", remote: "origin" }),
  ]));
  vi.mocked(mockTransport.getBranchComparison).mockReset().mockResolvedValue({
    base: null,
    compare: null,
    isUnborn: false,
    isComparisonAvailable: false,
  });
  vi.mocked(mockTransport.getRemoteUrl).mockReset().mockResolvedValue({ label: "repo", webUrl: null });
  vi.mocked(mockTransport.listWorkspaceActionRuns).mockReset().mockResolvedValue([]);
  vi.mocked(mockTransport.readWorkspaceEnvironment).mockReset().mockResolvedValue({
    document: {
      version: "0.0.1",
      setup: { default: "bun run setup" },
      actions: [{ id: "success", name: "Success", command: { default: "bun run success" } }],
    },
    revision: null,
    status: "present",
  });
  vi.mocked(mockTransport.saveWorkspaceEnvironment).mockReset();
  vi.mocked(mockTransport.startWorkspaceAction).mockReset().mockResolvedValue(runningActionRun());
}

/** Resets the transport, mocked stores, and real stores the ThreadOverview tests read. */
export function resetThreadOverviewState(): void {
  mockWorkspaceState.threads = [branchlessThread()];
  mockWorkspaceState.prUrlsByThreadId = {};
  mockWorkspaceState.checksById = {};
  mockWorkspaceState.worktreesLoadedForWorkspace = "ws-1";
  resetTransport();
  mockGetRightPanelVisible.mockReset().mockReturnValue(false);
  invalidateBranchTargets("ws-1");
  mockOpenSubagentsPanel.mockReset();
  mockThreadRecords.clear();
  useSubagentRosterStore.setState({ rosters: new Map(), errors: new Set() });
  useBrowserAutomationStore.setState({
    liveTargets: new Map(),
    lifecycleTabs: new Map(),
    controllers: new Map(),
  });
  usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {} });
  useOverviewStore.setState({ closedSubjects: new Set(), overlaySubject: null, requestedSubject: null });
  useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
  useProjectActionStore.setState({ runsByThread: {} });
  setLayoutMeasurements(1200, 1200);
}
