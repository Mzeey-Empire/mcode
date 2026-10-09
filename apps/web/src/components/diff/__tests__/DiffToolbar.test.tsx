import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "@mcode/contracts";
import { createMockWorkspace } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
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
    useDiffStore.setState({ viewMode: "unstaged", diffRevisionByScope: {}, reviewDiffStat: null, reviewFileCount: null });
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
});
