import { createMockWorkspace } from "@mcode/contracts/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewState, ReviewTurn, TurnSnapshot } from "@mcode/contracts";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useDiffStore } from "@/stores/diffStore";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import { ReviewHeader } from "../ReviewHeader";

const getReviewState = vi.mocked(mockTransport.getReviewState);
vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.getReviewState).mockReset();
});

const NOTHING_AHEAD: ReviewState = {
  isGitRepo: true, head: "abc123", branch: "feature",
  uncommitted: { staged: 0, unstaged: 1, untracked: 0 },
  commitsAhead: { count: 0, base: "main" }, branchDefault: { compare: "feature", base: "main" },
};

function header() {
  return (
    <ReviewHeader
      scopeId="workspace" comparison={null} refreshing={false} onRefresh={() => {}} defaultFilesExpanded
      filesNavigator={{ files: [], activePath: null, loading: false, error: null, onActivate: () => {}, docked: true }}
    />
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
      "review-view-turn", "review-view-since-looked", "review-view-cumulative", "review-view-unstaged",
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

describe("ReviewHeader Since you looked", () => {
  const turn = (ordinal: number): ReviewTurn => ({
    messageId: `msg-${ordinal}`, ordinal, createdAt: "2026-10-10T10:00:00Z", phase: "settled",
    fileCount: 1, additions: 1, deletions: 0, evidence: "native", availability: "available",
  });
  const snapshot = (ordinal: number, sequence: number): TurnSnapshot => ({
    id: `snap-${ordinal}`, message_id: `msg-${ordinal}`, thread_id: "thread", ref_before: "a", ref_after: "b",
    files_changed: ["a.ts"], worktree_path: null, created_at: "2026-10-10T10:00:00Z", attempt_count: 1,
    reverted_paths: [], message_sequence: sequence,
  });

  beforeEach(() => {
    getReviewState.mockReset().mockResolvedValue(NOTHING_AHEAD);
    useWorkspaceStore.setState({
      activeWorkspaceId: "workspace", activeThreadId: "thread", threads: [],
      workspaces: [createMockWorkspace({ id: "workspace" })],
    });
    useDiffStore.setState({
      diffRevisionByScope: {}, reviewViewMenuOpen: false,
      reviewTurnsByThread: { thread: [turn(2), turn(3), turn(4)] },
      snapshotsByThread: { thread: [snapshot(2, 4), snapshot(3, 6), snapshot(4, 8)] },
    });
    useDiffStore.getState().setReviewViewForThread("thread", "since-looked");
  });

  it("names the turns settled after the baseline as plain text in row 2", async () => {
    threadAttentionStore.setState({ visitBaselines: { thread: 4 } });
    render(header());
    expect(await screen.findByTestId("review-operand-slot")).toHaveTextContent(/^Turns 3–4$/);
  });

  it("leaves Since you looked when the visit has no baseline", async () => {
    threadAttentionStore.setState({ visitBaselines: {} });
    render(header());
    await waitFor(() => expect(useDiffStore.getState().viewMode).not.toBe("since-looked"));
  });
});
