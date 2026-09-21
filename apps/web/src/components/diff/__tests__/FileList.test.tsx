import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { pathsToReviewFiles } from "@/lib/review-comparison";
import { FileList } from "../FileList";

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

const transport = vi.hoisted(() => ({
  getSnapshotDiff: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

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
    });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("ResizeObserver", ObserverMock);
    vi.stubGlobal("IntersectionObserver", ObserverMock);
    transport.getSnapshotDiff.mockResolvedValue(
      "diff --git a/apps/web/src/beta.ts b/apps/web/src/beta.ts\n@@ -1 +1 @@\n-old\n+new",
    );
  });

  it("opens autocomplete on demand and jumps without filtering the tree", async () => {
    render(
      <FileList
        files={pathsToReviewFiles(["apps/web/src/alpha.ts", "apps/web/src/beta.ts"])}
        source="snapshot"
        id="snap-1"
        threadId="thread-1"
      />,
    );

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
        <FileList
          files={pathsToReviewFiles(files)}
          source="snapshot"
          id="snap-1"
          threadId="thread-1"
        />
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
});
