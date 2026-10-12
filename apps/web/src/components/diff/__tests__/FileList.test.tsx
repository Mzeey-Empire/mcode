import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { pathsToReviewFiles } from "@/lib/review-comparison";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import type { ReviewFileChange } from "@mcode/contracts";
import { FileList } from "../FileList";
import { ReviewHeader } from "../ReviewHeader";

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

const transport = vi.hoisted(() => ({
  getSnapshotDiff: vi.fn(),
  getReviewState: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

/** The header's jump control and the list it scrolls, as the Review panel pairs them. */
function ReviewWithJump({ files }: { readonly files: ReviewFileChange[] }) {
  return (
    <>
      <ReviewHeader
        scopeId="thread-1"
        comparison={{ files, additions: 0, deletions: 0 }}
        refreshing={false}
        onRefresh={() => {}}
        defaultFilesExpanded={false}
      />
      <FileList files={files} source="snapshot" id="snap-1" threadId="thread-1" />
    </>
  );
}

class ObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

describe("FileList jump to file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      inlineDiffCache: {},
      renderMode: "unified",
      lineWrapByThread: {},
      reviewFileJumpRequest: null,
    });
    useWorkspaceStore.setState({ activeWorkspaceId: null, activeThreadId: null, threads: [], workspaces: [] });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("ResizeObserver", ObserverMock);
    vi.stubGlobal("IntersectionObserver", ObserverMock);
    transport.getSnapshotDiff.mockResolvedValue(
      "diff --git a/apps/web/src/beta.ts b/apps/web/src/beta.ts\n@@ -1 +1 @@\n-old\n+new",
    );
  });

  it("opens autocomplete from the header on demand and jumps the list", async () => {
    render(<ReviewWithJump files={pathsToReviewFiles(["apps/web/src/alpha.ts", "apps/web/src/beta.ts"])} />);

    expect(screen.queryByTestId("review-file-filter")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("review-file-jump-trigger"));
    await userEvent.type(screen.getByTestId("review-file-filter"), "beta");
    await userEvent.click(screen.getByTestId("review-file-jump-item-apps/web/src/beta.ts"));

    expect(screen.queryByTestId("review-file-filter")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(transport.getSnapshotDiff).toHaveBeenCalledWith(
        "snap-1",
        "apps/web/src/beta.ts",
      ),
    );
  }, 15_000);

  it("keeps every file selectable through jump on long lists", async () => {
    const files = Array.from(
      { length: 80 },
      (_, index) => `apps/web/src/file-${String(index).padStart(2, "0")}.ts`,
    );

    render(
      <div data-slot="scroll-area-viewport">
        <ReviewWithJump files={pathsToReviewFiles(files)} />
      </div>,
    );

    await userEvent.click(screen.getByTestId("review-file-jump-trigger"));
    expect(screen.getAllByTestId(/^review-file-jump-item-/)).toHaveLength(80);
    await userEvent.click(screen.getByTestId("review-file-jump-item-apps/web/src/file-79.ts"));

    await waitFor(() =>
      expect(transport.getSnapshotDiff).toHaveBeenCalledWith(
        "snap-1",
        "apps/web/src/file-79.ts",
      ),
    );
  }, 15_000);

  it("consumes a pending jump request issued before the list mounted", async () => {
    useDiffStore.setState({
      reviewFileJumpRequest: {
        scopeId: "thread-1",
        path: "apps/web/src/beta.ts",
        nonce: 1,
      },
    });

    render(
      <FileList
        files={pathsToReviewFiles(["apps/web/src/alpha.ts", "apps/web/src/beta.ts"])}
        source="snapshot"
        id="snap-1"
        threadId="thread-1"
      />,
    );

    await waitFor(() =>
      expect(transport.getSnapshotDiff).toHaveBeenCalledWith(
        "snap-1",
        "apps/web/src/beta.ts",
      ),
    );
    expect(useDiffStore.getState().reviewFileJumpRequest).toBeNull();
  }, 15_000);

  it("consumes a view-keyed request only when the key matches", async () => {
    useDiffStore.setState({
      reviewFileJumpRequest: {
        scopeId: "thread-1",
        path: "apps/web/src/beta.ts",
        nonce: 1,
        viewKey: "turn:msg-1",
      },
    });
    const files = pathsToReviewFiles([
      "apps/web/src/alpha.ts",
      "apps/web/src/beta.ts",
    ]);

    const { unmount } = render(
      <FileList
        files={files}
        source="snapshot"
        id="snap-1"
        threadId="thread-1"
        jumpViewKey="turn:other-msg"
      />,
    );
    // Consumption clears the request synchronously, so flushing the mount
    // effects is enough to prove this list left it alone.
    await act(async () => {});
    expect(useDiffStore.getState().reviewFileJumpRequest).not.toBeNull();
    expect(transport.getSnapshotDiff).not.toHaveBeenCalled();
    unmount();

    render(
      <FileList
        files={files}
        source="snapshot"
        id="snap-2"
        threadId="thread-1"
        jumpViewKey="turn:msg-1"
      />,
    );
    await waitFor(() =>
      expect(transport.getSnapshotDiff).toHaveBeenCalledWith(
        "snap-2",
        "apps/web/src/beta.ts",
      ),
    );
    expect(useDiffStore.getState().reviewFileJumpRequest).toBeNull();
  }, 15_000);
});
