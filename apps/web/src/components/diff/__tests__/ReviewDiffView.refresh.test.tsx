import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewDiffView } from "@/components/diff/ReviewDiffView";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

const transport = vi.hoisted(() => ({
  getWorkingTreeDiff: vi.fn(),
  getBranchDiff: vi.fn(),
}));

vi.mock("@/transport", async (original) => ({
  ...(await original<object>()),
  getTransport: () => transport,
}));

// Observe the exact item contents delivered by the real component to its
// renderer; the bug under test lives in ReviewDiffView's patch state, not in
// pierre's paint pass.
vi.mock("@pierre/diffs/react", async (original) => ({
  ...(await original<object>()),
  CodeView: ({ items }: { items: unknown }) => (
    <pre data-testid="items">{JSON.stringify(items)}</pre>
  ),
}));

const patch = (text: string) =>
  `diff --git a/file.txt b/file.txt\nindex 1111111..2222222 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+${text}\n`;

const props = {
  files: [{ path: "file.txt", previousPath: null, changeType: "modified" as const, binary: false }],
  source: "unstaged" as const,
  id: "workspace-fixture",
  threadId: "thread-fixture",
  cacheVersion: 1,
  defaultFilesExpanded: true,
  jumpTarget: null,
  onJumpSettled: () => {},
  highlightPath: null,
  renderMode: "unified" as const,
  lineWrap: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-fixture", threads: [] });
  useDiffStore.setState({ inlineDiffCache: {}, bulkDiffExpand: null });
  transport.getWorkingTreeDiff.mockResolvedValue(patch("FIRST_VERSION"));
  transport.getBranchDiff.mockResolvedValue(patch("NEW_BRANCH"));
});

afterEach(cleanup);

describe("ReviewDiffView refresh", () => {
  it("refetches an expanded file when cacheVersion changes", async () => {
    const view = render(<ReviewDiffView {...props} />);
    await waitFor(() =>
      expect(screen.getByTestId("items").textContent).toContain("FIRST_VERSION"),
    );

    transport.getWorkingTreeDiff.mockResolvedValue(patch("SECOND_VERSION"));
    act(() => useDiffStore.getState().bumpDiffRevision("thread-fixture"));
    view.rerender(<ReviewDiffView {...props} cacheVersion={2} />);

    await waitFor(() =>
      expect(screen.getByTestId("items").textContent).toContain("SECOND_VERSION"),
    );
    expect(transport.getWorkingTreeDiff.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("items").textContent).not.toContain("FIRST_VERSION");
  });

  it("refetches a same-named file when the comparison range changes", async () => {
    const view = render(<ReviewDiffView {...props} source="branch" id="main...branchA" />);
    await waitFor(() =>
      expect(screen.getByTestId("items").textContent).toContain("NEW_BRANCH"),
    );

    transport.getBranchDiff.mockResolvedValue(patch("BRANCH_B"));
    view.rerender(
      <ReviewDiffView {...props} source="branch" id="main...branchB" cacheVersion={2} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("items").textContent).toContain("BRANCH_B"),
    );
    expect(transport.getBranchDiff.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("items").textContent).not.toContain("NEW_BRANCH");
  });

  it("drops an in-flight response from a superseded comparison", async () => {
    let resolveFirst: (value: string) => void = () => {};
    transport.getBranchDiff.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );
    const view = render(<ReviewDiffView {...props} source="branch" id="main...branchA" />);
    await waitFor(() => expect(transport.getBranchDiff).toHaveBeenCalledTimes(1));

    transport.getBranchDiff.mockResolvedValue(patch("BRANCH_B"));
    view.rerender(
      <ReviewDiffView {...props} source="branch" id="main...branchB" cacheVersion={2} />,
    );

    // The superseded request resolves after the switch; its payload must not win.
    await act(async () => resolveFirst(patch("STALE_A")));
    await waitFor(() =>
      expect(screen.getByTestId("items").textContent).toContain("BRANCH_B"),
    );
    expect(screen.getByTestId("items").textContent).not.toContain("STALE_A");
  });

  it("does not seed a superseded in-flight response on remount", async () => {
    let resolveFirst: (value: string) => void = () => {};
    transport.getWorkingTreeDiff.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );
    const view = render(<ReviewDiffView {...props} />);
    await waitFor(() => expect(transport.getWorkingTreeDiff).toHaveBeenCalledTimes(1));

    transport.getWorkingTreeDiff.mockResolvedValue(patch("SECOND_VERSION"));
    act(() => useDiffStore.getState().bumpDiffRevision("thread-fixture"));
    view.rerender(<ReviewDiffView {...props} cacheVersion={2} />);
    await waitFor(() =>
      expect(screen.getByTestId("items").textContent).toContain("SECOND_VERSION"),
    );

    // The revision-1 request resolves late; its payload lands under the
    // revision-1 cache key, which a revision-2 remount must never seed from.
    await act(async () => resolveFirst(patch("STALE_V1")));
    view.unmount();
    render(<ReviewDiffView {...props} cacheVersion={2} />);

    await waitFor(() =>
      expect(screen.getByTestId("items").textContent).toContain("SECOND_VERSION"),
    );
    expect(screen.getByTestId("items").textContent).not.toContain("STALE_V1");
    expect(transport.getWorkingTreeDiff).toHaveBeenCalledTimes(2);
  });
});
