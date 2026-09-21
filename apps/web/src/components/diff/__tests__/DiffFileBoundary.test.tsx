import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { pathsToReviewFiles } from "@/lib/review-comparison";
import { FileList } from "../FileList";

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

const transport = vi.hoisted(() => ({
  getSnapshotDiff: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

class IntersectionObserverMock {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("FileList file headers", () => {
  beforeEach(() => {
    useDiffStore.setState({
      inlineDiffCache: {},
      renderMode: "unified",
      lineWrapByThread: {},
    });
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  it("renders a header for each changed file", async () => {
    render(
      <FileList
        files={pathsToReviewFiles(["apps/web/src/alpha.ts", "apps/web/src/beta.ts"])}
        source="snapshot"
        id="snap-1"
        threadId="thread-1"
      />,
    );

    // Filenames render inside pierre's shadow header; the slotted collapse
    // toggle carries the path in its accessible name as the light-DOM signal.
    expect(
      await screen.findByRole("button", { name: "Expand apps/web/src/alpha.ts" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Expand apps/web/src/beta.ts" }),
    ).toBeInTheDocument();
  });
});
