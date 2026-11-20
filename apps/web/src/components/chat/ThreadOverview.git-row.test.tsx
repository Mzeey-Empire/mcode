import { act, render, screen, waitFor, within } from "@testing-library/react";
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

// The shared mock serves a frozen diff revision; this file reads the real one so a bumped
// revision re-probes Review, as an agent's file edit does.
vi.mock("@/stores/diffStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/diffStore")>();
  const mocked = (await import("./__tests__/thread-overview-mocks")).mockDiffStoreModule(actual);
  const withLiveRevision = vi.fn((select: (state: never) => unknown) => {
    const { diffRevisionByScope, checkoutEpoch } = actual.useDiffStore.getState();
    return (mocked.useDiffStore as unknown as (pick: (state: object) => unknown) => unknown)(
      (state) => select({ ...state, diffRevisionByScope, checkoutEpoch } as never),
    );
  });
  Object.assign(withLiveRevision, actual.useDiffStore);
  return { ...mocked, useDiffStore: withLiveRevision };
});

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
import { useHasCommitsAhead } from "@/hooks/useHasCommitsAhead";
import { useDiffStore } from "@/stores/diffStore";
import type { Thread } from "@/transport";
import { mockWorkspaceState } from "./__tests__/thread-overview-mocks";
import { branchlessThread, resetThreadOverviewState } from "./__tests__/thread-overview-harness";
import { ThreadOverview } from "./ThreadOverview";

function reviewUncommitted(count: number) {
  vi.mocked(mockTransport.getReviewState).mockResolvedValue({
    isGitRepo: true,
    head: "abc123",
    branch: "feat/x",
    uncommitted: { staged: 0, unstaged: count, untracked: 0 },
    commitsAhead: null,
    branchDefault: { unavailable: "no-base" },
  });
}

function namedThread(overrides: Partial<Thread> = {}): Thread {
  return branchlessThread({ checkout_state: "named", branch: "feat/x", ...overrides });
}

function renderOverview(thread: Thread) {
  mockWorkspaceState.threads = [thread];
  return render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
}

async function settleReview() {
  await waitFor(() => expect(mockTransport.getReviewState).toHaveBeenCalled());
  await act(async () => {});
}

describe("ThreadOverview git row", () => {
  beforeEach(() => {
    resetThreadOverviewState();
    useDiffStore.getState().setCommitSheetScopeId(null);
    vi.mocked(useHasCommitsAhead).mockReturnValue(null);
    reviewUncommitted(0);
  });

  it("opens the Create branch dialog from a detached worktree's git row", async () => {
    const user = userEvent.setup();
    renderOverview(branchlessThread());

    const row = screen.getByTestId("thread-overview-git");
    await user.click(within(row).getByRole("button", { name: "Create branch…" }));
    expect(screen.getByRole("heading", { name: "Work here" })).toBeInTheDocument();
  });

  it("opens the Commit sheet from a detached worktree's git menu", async () => {
    const user = userEvent.setup();
    renderOverview(branchlessThread());

    await user.click(screen.getByRole("button", { name: "More git actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Commit…" }));
    expect(useDiffStore.getState().commitSheetScopeId).toBe("thread-1");
    expect(useDiffStore.getState().commitSheetPush).toBe(false);
  });

  it("leads a dirty named worktree with Commit… and offers Commit and push… set to push", async () => {
    const user = userEvent.setup();
    reviewUncommitted(3);
    renderOverview(namedThread());

    const main = await screen.findByTestId("workspace-menu-commit");
    expect(main).toHaveTextContent("Commit…");
    await user.click(screen.getByRole("button", { name: "More git actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Commit and push…" }));
    expect(useDiffStore.getState().commitSheetScopeId).toBe("thread-1");
    expect(useDiffStore.getState().commitSheetPush).toBe(true);
  });

  it("offers Create PR… without a menu on a clean worktree with commits ahead", async () => {
    const user = userEvent.setup();
    vi.mocked(useHasCommitsAhead).mockReturnValue(true);
    renderOverview(namedThread());

    await user.click(await screen.findByRole("button", { name: "Create PR…" }));
    expect(screen.getByTestId("create-pr-dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More git actions" })).not.toBeInTheDocument();
  });

  it("hides the git row on a clean worktree with nothing ahead", async () => {
    vi.mocked(useHasCommitsAhead).mockReturnValue(false);
    renderOverview(namedThread());
    await settleReview();
    expect(screen.queryByTestId("thread-overview-git")).not.toBeInTheDocument();
  });

  it("shows the Open PR row instead of the git row once the thread has a PR", async () => {
    reviewUncommitted(2);
    vi.mocked(useHasCommitsAhead).mockReturnValue(true);
    renderOverview(namedThread({ pull_requests: [createMockThreadPullRequest({ number: 42, state: "open", url: "https://example.test/pr/42" })] }));
    await settleReview();
    expect(screen.getByTestId("workspace-menu-open-pr")).toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-git")).not.toBeInTheDocument();
  });

  it("shows no git row on a Direct-mode thread", async () => {
    reviewUncommitted(2);
    renderOverview(namedThread({ mode: "direct", worktree_path: null }));
    await settleReview();
    expect(screen.queryByTestId("thread-overview-git")).not.toBeInTheDocument();
  });

  it("keeps the step under the pointer until the pointer leaves", async () => {
    const user = userEvent.setup();
    reviewUncommitted(1);
    vi.mocked(useHasCommitsAhead).mockReturnValue(true);
    const thread = namedThread();
    const { rerender } = renderOverview(thread);

    await screen.findByRole("button", { name: "Commit…" });
    await user.hover(screen.getByTestId("thread-overview-git"));
    const probes = vi.mocked(mockTransport.getReviewState).mock.calls.length;
    reviewUncommitted(0);
    act(() => useDiffStore.getState().bumpDiffRevision("thread-1"));
    rerender(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await waitFor(() => expect(vi.mocked(mockTransport.getReviewState).mock.calls.length).toBeGreaterThan(probes));
    await act(async () => {});
    expect(screen.getByTestId("thread-overview-git")).toHaveTextContent("Commit…");

    await user.unhover(screen.getByTestId("thread-overview-git"));
    expect(await screen.findByRole("button", { name: "Create PR…" })).toBeInTheDocument();
  });
});
