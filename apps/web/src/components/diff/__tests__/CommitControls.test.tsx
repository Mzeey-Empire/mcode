// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockTransport } from "@/__tests__/mocks/transport";
import { useDiffStore } from "@/stores/diffStore";
import { CommitControls } from "../CommitControls";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

function arrangeDirtyCheckout() {
  vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({
    status: "ready",
    comparison: { files: [], additions: 0, deletions: 0 },
  });
  vi.mocked(mockTransport.getReviewState).mockResolvedValue({
    isGitRepo: true,
    head: "a".repeat(40),
    branch: "feat/x",
    uncommitted: { staged: 0, unstaged: 2, untracked: 0 },
    commitsAhead: null,
    branchDefault: { base: "main", compare: "feat/x" },
  });
}

afterEach(() => {
  useDiffStore.getState().setCommitSheetScopeId(null);
});

describe("CommitControls", () => {
  it("shows a labelled Commit button that opens the commit sheet", async () => {
    arrangeDirtyCheckout();
    render(<CommitControls workspaceId="ws-1" threadId="thread-1" scopeId="thread-1" activePath={null} />);

    const trigger = await screen.findByRole("button", { name: "Commit" });
    // Visible text, not just an aria-label: an icon-only button hid the action from newcomers.
    expect(trigger).toHaveTextContent("Commit");
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(trigger);

    expect(await screen.findByRole("dialog", { name: "Commit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit", pressed: true })).toBe(trigger);
  });
});
