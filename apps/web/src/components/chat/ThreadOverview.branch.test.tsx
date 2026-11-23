import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { mockWorkspaceState } from "./__tests__/thread-overview-mocks";
import { branchlessThread, resetThreadOverviewState } from "./__tests__/thread-overview-harness";
import { ThreadOverview } from "./ThreadOverview";

describe("ThreadOverview branch create and commit", () => {
  beforeEach(() => {
    resetThreadOverviewState();
  });

  it("opens the Commit sheet on Review from the branchless worktree's git menu", async () => {
    const user = userEvent.setup();
    const thread = branchlessThread({ branch: "release", base_branch: "release" });
    mockWorkspaceState.threads = [thread];
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await act(async () => {});

    await user.click(screen.getByTestId("thread-overview-local"));
    await user.click(await screen.findByRole("button", { name: "More git actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Commit…" }));

    const diff = useDiffStore.getState();
    expect(diff.commitSheetScopeId).toBe("thread-1");
    expect(diff.getRightPanel("ws-1", "thread-1")).toMatchObject({ visible: true, activeTab: "changes" });
  });

  it("creates a named branch from the branchless worktree row", async () => {
    const user = userEvent.setup();
    const thread = branchlessThread({ branch: "release", base_branch: "release" });
    mockWorkspaceState.threads = [thread];
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await act(async () => {});

    await user.click(screen.getByTestId("thread-overview-local"));
    expect(await screen.findByTestId("thread-overview-local-branch")).toHaveTextContent("detached from release");
    expect(screen.queryByLabelText("Copy branch")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("thread-overview-local"));
    expect(screen.getByTestId("workspace-menu-branch")).toHaveTextContent("detached from release");
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();

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

  it("states where a detached worktree's HEAD sits before offering to create a branch", async () => {
    render(<ThreadOverview thread={branchlessThread({ head_sha: "3f9a1c2" })} threadPaneWidth={1400} />);
    await act(async () => {});

    const branchRow = screen.getByTestId("workspace-menu-branch");
    const createRow = screen.getByTestId("thread-overview-create-branch");
    expect(branchRow).toHaveTextContent("detached at 3f9a1c2");
    expect(createRow).toHaveTextContent("Create branch…");
    expect(branchRow.compareDocumentPosition(createRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves branch creation to the card row when the picker opens on a detached worktree", async () => {
    const user = userEvent.setup();
    render(<ThreadOverview thread={branchlessThread({ head_sha: "3f9a1c2" })} threadPaneWidth={1400} />);
    await act(async () => {});
    await user.click(screen.getByTestId("workspace-menu-branch"));

    const picker = await screen.findByTestId("thread-overview-branch-popover");
    expect(await within(picker).findByRole("button", { name: "feature/other" })).toBeInTheDocument();
    expect(within(picker).queryByRole("button", { name: /Create and check out branch/ })).not.toBeInTheDocument();
  });

  it("lists a detached worktree's checkout under the card's label, not as a HEAD branch", async () => {
    const user = userEvent.setup();
    render(<ThreadOverview thread={branchlessThread({ head_sha: "3f9a1c2" })} threadPaneWidth={1400} />);
    await act(async () => {});
    await user.click(screen.getByTestId("workspace-menu-branch"));

    const picker = await screen.findByTestId("thread-overview-branch-popover");
    await within(picker).findByRole("button", { name: "feature/other" });
    expect(within(picker).getByTestId("thread-overview-current-branch")).toHaveTextContent("detached at 3f9a1c2");
    expect(within(picker).queryByRole("button", { name: "HEAD" })).not.toBeInTheDocument();
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
    await act(async () => {});

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
    await act(async () => {});

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue-801" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("branch exists");
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });
});
