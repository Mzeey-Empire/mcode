import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/transport", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockTransportModule(
    await importOriginal<typeof import("@/transport")>(),
  ),
);

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
import { branchlessThread, gitRef, refsPage, resetThreadOverviewState } from "./__tests__/thread-overview-harness";
import { ThreadOverview } from "./ThreadOverview";

describe("ThreadOverview changes and branches", () => {
  beforeEach(() => {
    resetThreadOverviewState();
  });

  it("loads untracked changes from the branchless checkout comparison", async () => {
    vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({ status: "ready", comparison: {
      files: [{ path: "notes.md", previousPath: null, changeType: "added", binary: false, additions: 4, deletions: 0, untracked: true }],
      additions: 4, deletions: 0,
    } });
    render(<ThreadOverview thread={branchlessThread()} threadPaneWidth={1400} />);
    expect(await screen.findByTestId("thread-overview-change-summary")).toHaveAttribute("aria-label", "4 additions, 0 deletions");
    expect(vi.mocked(mockTransport.getReviewComparison)).toHaveBeenCalledWith({
      workspaceId: "ws-1", threadId: "thread-1", view: "uncommitted",
    });
    expect(vi.mocked(mockTransport.getReviewState)).not.toHaveBeenCalled();
  });

  it("says the Changes row is unavailable when its comparison fails", async () => {
    vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({
      status: "failed", failure: { kind: "git-error", summary: "Git reported an error", detail: "fatal" },
    });
    render(<ThreadOverview thread={branchlessThread()} threadPaneWidth={1400} />);
    expect(await screen.findByTestId("thread-overview-change-failed")).toHaveTextContent("Unavailable");
    expect(screen.queryByTestId("thread-overview-change-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-change-summary")).not.toBeInTheDocument();
  });

  it("keeps branch choices when the uncommitted comparison fails", async () => {
    vi.mocked(mockTransport.getReviewComparison).mockRejectedValue(new Error("Comparison unavailable"));
    const user = userEvent.setup();
    render(<ThreadOverview thread={branchlessThread({ checkout_state: "named" })} threadPaneWidth={1400} />);
    await user.click(screen.getByTestId("workspace-menu-branch"));
    expect(await screen.findByRole("button", { name: "feature/other" })).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-current-branch")).toHaveTextContent("main");
    expect(screen.queryByText("Branches unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText(/Uncommitted:/)).not.toBeInTheDocument();
  });

  it("lists the checkout's local branches and searches them on the server", async () => {
    const user = userEvent.setup();
    render(<ThreadOverview thread={branchlessThread({ checkout_state: "named" })} threadPaneWidth={1400} />);
    await user.click(screen.getByTestId("workspace-menu-branch"));

    expect(await screen.findByRole("button", { name: "feature/other" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "origin/other" })).not.toBeInTheDocument();
    expect(vi.mocked(mockTransport.listRefs)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", threadId: "thread-1", purpose: "new-thread" }),
    );

    vi.mocked(mockTransport.listRefs).mockResolvedValue(refsPage([gitRef("feature/other")]));
    await user.type(screen.getByLabelText("Search branches"), "feat");

    await waitFor(() => expect(vi.mocked(mockTransport.listRefs)).toHaveBeenCalledWith(expect.objectContaining({ query: "feat" })));
    const list = screen.getByTestId("thread-overview-branch-list");
    await waitFor(() => expect(within(list).queryByRole("button", { name: "main" })).not.toBeInTheDocument());
    expect(within(list).getByRole("button", { name: "feature/other" })).toBeInTheDocument();
  });

  it("keeps the checkout's branch and says the list is unavailable when listing fails", async () => {
    vi.mocked(mockTransport.listRefs).mockResolvedValue({ ok: false, error: { code: "git_failed", message: "Could not list targets" } });
    const user = userEvent.setup();
    render(<ThreadOverview thread={branchlessThread({ checkout_state: "named" })} threadPaneWidth={1400} />);
    await user.click(screen.getByTestId("workspace-menu-branch"));

    expect(await screen.findByText("Branches unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-current-branch")).toHaveTextContent("main");
  });

  it("uses the state probe's detached comparison when the worktree is clean", async () => {
    vi.mocked(mockTransport.getReviewState).mockResolvedValue({
      isGitRepo: true, head: "abc123", branch: null,
      uncommitted: { staged: 0, unstaged: 0, untracked: 0 },
      commitsAhead: { count: 1, base: "main" }, branchDefault: { base: "main", compare: "HEAD" },
    });
    vi.mocked(mockTransport.getReviewComparison)
      .mockResolvedValueOnce({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } })
      .mockResolvedValue({ status: "ready", comparison: { files: [{ path: "existing.md", previousPath: null, changeType: "modified", binary: false, additions: 3, deletions: 1, untracked: false }], additions: 3, deletions: 1 } });
    render(<ThreadOverview thread={branchlessThread()} threadPaneWidth={1400} />);
    expect(await screen.findByTestId("thread-overview-change-summary")).toHaveAttribute("aria-label", "3 additions, 1 deletions");
    expect(vi.mocked(mockTransport.getReviewState)).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(vi.mocked(mockTransport.getReviewComparison)).toHaveBeenLastCalledWith({
      workspaceId: "ws-1", threadId: "thread-1", view: "branch", base: "main", compare: "HEAD",
    });
  });
});
