import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "@mcode/contracts";
import { createMockWorkspace } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import { DiffToolbar } from "../DiffToolbar";

const { getReviewState } = vi.hoisted(() => ({ getReviewState: vi.fn<() => Promise<ReviewState>>() }));
vi.mock("@/transport", () => ({ getTransport: () => ({ getReviewState }) }));

describe("DiffToolbar review availability", () => {
  beforeEach(() => {
    getReviewState.mockReset();
    useWorkspaceStore.setState({
      activeWorkspaceId: "workspace", activeThreadId: null, threads: [],
      workspaces: [createMockWorkspace({ id: "workspace" })],
    });
    useDiffStore.setState({ viewMode: "unstaged", diffRevisionByScope: {}, reviewDiffStat: null, reviewFileCount: null, reviewViewMenuOpen: false });
  });

  it("disables Commit and Branch after rejection and restores them on a successful refresh", async () => {
    getReviewState.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<DiffToolbar />);
    await user.click(screen.getByRole("button", { name: "Select review view" }));
    await waitFor(() => {
      expect(screen.getByTestId("review-view-commit")).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByTestId("review-view-branch")).toHaveAttribute("aria-disabled", "true");
    });
    expect(screen.getByTestId("review-view-commit")).toHaveAccessibleDescription("No commits to review");
    expect(screen.getByTestId("review-view-branch")).toHaveAccessibleDescription("No branch changes to review");

    await user.keyboard("{Escape}");
    getReviewState.mockResolvedValue({
      isGitRepo: true, head: "abc123", branch: "feature",
      uncommitted: { staged: 0, unstaged: 0, untracked: 0 },
      commitsAhead: { count: 1, base: "main" }, branchDefault: { compare: "feature", base: "main" },
    });
    await user.click(screen.getByRole("button", { name: "Select review view" }));
    await waitFor(() => {
      expect(screen.getByTestId("review-view-commit")).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByTestId("review-view-branch")).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByTestId("review-view-commit")).not.toHaveAttribute("aria-describedby");
      expect(screen.getByTestId("review-view-branch")).not.toHaveAttribute("aria-describedby");
    });
  });

  it("clears the shared view menu flag when Review hides so the menu stays closed on return", async () => {
    getReviewState.mockRejectedValue(new Error("offline"));
    const toolbar = (visible: boolean) => (
      <OverlayGateContext.Provider value={visible}>
        <DiffToolbar />
      </OverlayGateContext.Provider>
    );
    const { rerender } = render(toolbar(true));
    await userEvent.setup().click(screen.getByRole("button", { name: "Select review view" }));
    expect(await screen.findByTestId("review-view-commit")).toBeInTheDocument();

    rerender(toolbar(false));
    await waitFor(() => expect(useDiffStore.getState().reviewViewMenuOpen).toBe(false));

    rerender(toolbar(true));
    expect(screen.queryByTestId("review-view-commit")).not.toBeInTheDocument();
  });
});
