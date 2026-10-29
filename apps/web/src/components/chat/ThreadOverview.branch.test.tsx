import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMockThreadPullRequest } from "@mcode/contracts/testing";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transport")>()),
  getTransport: () => mockTransport,
}));

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: vi.fn().mockReturnValue(null),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: vi.fn().mockReturnValue(null),
}));

vi.mock("@/features/projects/state/workspaceStore", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockWorkspaceStoreModule(),
);

vi.mock("@/stores/diffStore", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockDiffStoreModule(
    await importOriginal<typeof import("@/stores/diffStore")>(),
  ),
);

vi.mock("@/stores/threadStore", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockThreadStoreModule(),
);

vi.mock("@/features/subagents", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockSubagentsModule(
    await importOriginal<typeof import("@/features/subagents")>(),
  ),
);

vi.mock("@/components/ui/dialog", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockDialogModule(),
);

vi.mock("./CreatePrDialog", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockCreatePrDialogModule(),
);

import { mockTransport } from "@/__tests__/mocks/transport";
import { useDiffStore } from "@/stores/diffStore";
import { canStartBranchlessCreatePr } from "@/features/thread-overview/branch-creation";
import { mockWorkspaceState } from "./__tests__/thread-overview-mocks";
import { branchlessThread, resetThreadOverviewState } from "./__tests__/thread-overview-harness";
import { ThreadOverview } from "./ThreadOverview";

describe("ThreadOverview branch create and commit", () => {
  beforeEach(() => {
    resetThreadOverviewState();
  });

  it("classifies only branchless worktrees as branch-name Create PR candidates", () => {
    expect(canStartBranchlessCreatePr(branchlessThread())).toBe(true);
    expect(canStartBranchlessCreatePr(branchlessThread({ checkout_state: "named" }))).toBe(false);
    expect(canStartBranchlessCreatePr(branchlessThread({ mode: "direct" }))).toBe(false);
  });

  it("opens the Commit sheet on Review from the branchless worktree row", async () => {
    const user = userEvent.setup();
    const thread = branchlessThread({ branch: "release", base_branch: "release" });
    mockWorkspaceState.threads = [thread];
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    await user.click(screen.getByTestId("thread-overview-local"));
    await user.click(await screen.findByTestId("workspace-menu-commit"));

    const diff = useDiffStore.getState();
    expect(diff.commitSheetScopeId).toBe("thread-1");
    expect(diff.getRightPanel("ws-1", "thread-1")).toMatchObject({ visible: true, activeTab: "changes" });
  });

  it("creates a named branch from the branchless worktree row", async () => {
    const user = userEvent.setup();
    const thread = branchlessThread({ branch: "release", base_branch: "release" });
    mockWorkspaceState.threads = [thread];
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    await user.click(screen.getByTestId("thread-overview-local"));
    expect(await screen.findByText("detached from release")).toBeInTheDocument();
    expect(screen.queryByLabelText("Copy branch")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("thread-overview-local"));
    expect(screen.queryByTestId("workspace-menu-branch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-menu-commit")).toBeEnabled();

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    expect(screen.getByRole("heading", { name: "Work here" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue 801" },
    });
    expect(screen.getByLabelText("Branch name")).toHaveValue("feat/issue-801");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(vi.mocked(mockTransport.createBranch)).toHaveBeenCalledWith("ws-1", "feat/issue-801", "thread-1");
    });

    expect(mockWorkspaceState.threads[0]).toMatchObject({
      id: "thread-1",
      branch: "feat/issue-801",
      checkout_state: "named",
      base_branch: "release",
    });
    expect(mockWorkspaceState.worktreesLoadedForWorkspace).toBeNull();
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });

  it("clears stale PR metadata and caches when creating a named branch", async () => {
    mockWorkspaceState.threads = [
      branchlessThread({
        pull_requests: [createMockThreadPullRequest({ number: 42, state: "open" })],
        base_branch: "release",
      }),
    ];
    mockWorkspaceState.prUrlsByThreadId = {
      "thread-1": "https://example.test/pr/42",
      other: "https://example.test/pr/7",
    };
    mockWorkspaceState.checksById = {
      "thread-1": { aggregate: "passing", runs: [], fetchedAt: 1 },
      other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
    };
    render(<ThreadOverview thread={mockWorkspaceState.threads[0]} threadPaneWidth={1400} />);

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue 801" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockWorkspaceState.threads[0]).toMatchObject({
        branch: "feat/issue-801",
        checkout_state: "named",
        base_branch: "release",
        
      });
    });
    expect(mockWorkspaceState.prUrlsByThreadId).toEqual({
      other: "https://example.test/pr/7",
    });
    expect(mockWorkspaceState.checksById).toEqual({
      other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
    });
  });

  it("keeps the branch creation dialog open when branch creation fails", async () => {
    vi.mocked(mockTransport.createBranch).mockRejectedValueOnce(new Error("branch exists"));
    render(<ThreadOverview thread={branchlessThread()} threadPaneWidth={1400} />);

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue-801" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("branch exists");
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });
});
