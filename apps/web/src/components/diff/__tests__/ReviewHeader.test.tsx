import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "@mcode/contracts";
import { createMockWorkspace } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import { ReviewHeader } from "../ReviewHeader";

const { getReviewState } = vi.hoisted(() => ({ getReviewState: vi.fn<() => Promise<ReviewState>>() }));
vi.mock("@/transport", () => ({ getTransport: () => ({ getReviewState }) }));

const NOTHING_AHEAD: ReviewState = {
  isGitRepo: true, head: "abc123", branch: "feature",
  uncommitted: { staged: 0, unstaged: 1, untracked: 0 },
  commitsAhead: { count: 0, base: "main" }, branchDefault: { compare: "feature", base: "main" },
};

function header() {
  return (
    <ReviewHeader scopeId="workspace" comparison={null} refreshing={false} onRefresh={() => {}} defaultFilesExpanded />
  );
}

describe("ReviewHeader view menu", () => {
  beforeEach(() => {
    getReviewState.mockReset().mockResolvedValue(NOTHING_AHEAD);
    useWorkspaceStore.setState({
      activeWorkspaceId: "workspace", activeThreadId: null, threads: [],
      workspaces: [createMockWorkspace({ id: "workspace" })],
    });
    useDiffStore.setState({ viewMode: "unstaged", diffRevisionByScope: {}, reviewViewMenuOpen: false });
  });

  it("lists view names in three groups and dims the ones that cannot load with their reason", async () => {
    const user = userEvent.setup();
    render(header());
    await user.click(screen.getByRole("button", { name: "Select review view" }));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.dataset.testid)).toEqual([
      "review-view-turn", "review-view-cumulative", "review-view-unstaged",
      "review-view-staged", "review-view-commit", "review-view-branch",
    ]);
    expect(screen.getByTestId("review-view-cumulative")).toHaveTextContent(/^All turns/);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    expect(screen.getByTestId("review-view-turn")).toHaveAccessibleDescription("Open a thread to review its turns");
    await waitFor(() =>
      expect(screen.getByTestId("review-view-commit")).toHaveAccessibleDescription("No commits ahead of main"),
    );
    expect(screen.getByTestId("review-view-staged")).toHaveAccessibleDescription("Nothing staged");
    expect(screen.getByTestId("review-view-branch")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("probes again on each open so a view becomes available without a reload", async () => {
    const user = userEvent.setup();
    render(header());
    await user.click(screen.getByRole("button", { name: "Select review view" }));
    await waitFor(() => expect(screen.getByTestId("review-view-commit")).toHaveAttribute("aria-disabled", "true"));

    await user.keyboard("{Escape}");
    getReviewState.mockResolvedValue({ ...NOTHING_AHEAD, commitsAhead: { count: 1, base: "main" } });
    await user.click(screen.getByRole("button", { name: "Select review view" }));
    await waitFor(() => expect(screen.getByTestId("review-view-commit")).not.toHaveAttribute("aria-disabled", "true"));
  });

  it("clears the shared view menu flag when Review hides so the menu stays closed on return", async () => {
    const gated = (visible: boolean) => (
      <OverlayGateContext.Provider value={visible}>{header()}</OverlayGateContext.Provider>
    );
    const { rerender } = render(gated(true));
    await userEvent.setup().click(screen.getByRole("button", { name: "Select review view" }));
    // Wait for the probe to settle; it re-renders the dimmed rows.
    await waitFor(() => expect(screen.getByTestId("review-view-commit")).toHaveAttribute("aria-disabled", "true"));

    rerender(gated(false));
    await waitFor(() => expect(useDiffStore.getState().reviewViewMenuOpen).toBe(false));

    rerender(gated(true));
    expect(screen.queryByTestId("review-view-commit")).not.toBeInTheDocument();
  });
});
