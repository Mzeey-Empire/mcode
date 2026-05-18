import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TurnSnapshot } from "@mcode/contracts";
import { TurnTimeline } from "../components/diff/TurnTimeline";

// Mock the transport so FileEntry's lazy diff load resolves immediately.
vi.mock("@/transport", () => ({
  getTransport: () => ({
    getSnapshotDiff: vi.fn().mockResolvedValue("@@ -0,0 +1 @@\n+hello\n"),
    getCumulativeDiff: vi.fn().mockResolvedValue(""),
    getCommitDiff: vi.fn().mockResolvedValue(""),
  }),
}));

// Mock heavy diff renderers to keep tests fast and avoid unrelated failures.
vi.mock("../components/diff/UnifiedDiff", () => ({
  UnifiedDiff: ({ lines }: { lines: unknown[] }) => (
    <div data-testid="unified-diff">{lines.length} lines</div>
  ),
}));
vi.mock("../components/diff/SideBySideDiff", () => ({
  SideBySideDiff: () => <div data-testid="side-by-side-diff" />,
}));
vi.mock("../components/diff/DiffPreview", () => ({
  DiffPreview: () => <div data-testid="diff-preview" />,
}));

/** Minimal snapshot factory. */
function snap(id: string, files: string[]): TurnSnapshot {
  return {
    id,
    thread_id: "t1",
    ref_before: "aaa",
    ref_after: "bbb",
    files_changed: files,
    created_at: new Date().toISOString(),
  } as TurnSnapshot;
}

describe("TurnTimeline auto-expand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expands the latest turn by default", () => {
    const snapshots = [
      snap("s1", ["a.ts"]),
      snap("s2", ["b.ts", "c.ts"]),
    ];

    render(<TurnTimeline snapshots={snapshots} />);

    // The latest turn (s2, rendered first after reverse) should have aria-expanded=true
    const buttons = screen.getAllByRole("button", { expanded: true });
    expect(buttons.length).toBeGreaterThanOrEqual(1);

    // Its content region should be visible (the file list is rendered)
    const contentRegion = document.getElementById("turn-entry-content-s2");
    expect(contentRegion).toBeTruthy();
  });

  it("keeps older turns collapsed", () => {
    const snapshots = [
      snap("s1", ["a.ts"]),
      snap("s2", ["b.ts"]),
    ];

    render(<TurnTimeline snapshots={snapshots} />);

    // The older turn (s1) should not have its content rendered
    const contentRegion = document.getElementById("turn-entry-content-s1");
    expect(contentRegion).toBeNull();
  });

  it("keeps the latest turn expanded across re-renders with new snapshots", () => {
    const initial = [snap("s1", ["a.ts"])];
    const { rerender } = render(<TurnTimeline snapshots={initial} />);

    // s1 is the latest and should be expanded
    expect(document.getElementById("turn-entry-content-s1")).toBeTruthy();

    // A new turn arrives — s2 becomes the latest
    const updated = [snap("s1", ["a.ts"]), snap("s2", ["b.ts"])];
    rerender(<TurnTimeline snapshots={updated} />);

    // s2 should now be expanded (latest)
    expect(document.getElementById("turn-entry-content-s2")).toBeTruthy();
  });

  it("auto-expands file diffs inside the latest turn", async () => {
    const snapshots = [snap("s1", ["readme.md"])];

    render(<TurnTimeline snapshots={snapshots} />);

    // The turn content region should be visible
    const contentRegion = document.getElementById("turn-entry-content-s1");
    expect(contentRegion).toBeTruthy();

    // The file entry inside the latest turn should also start expanded,
    // triggering a diff load. Wait for the mocked transport to resolve.
    const diffEl = await screen.findByTestId("unified-diff");
    expect(diffEl).toBeTruthy();
  });

  it("does NOT auto-expand file diffs in older turns", () => {
    const snapshots = [
      snap("s1", ["a.ts"]),
      snap("s2", ["b.ts"]),
    ];

    render(<TurnTimeline snapshots={snapshots} />);

    // The older turn (s1) should be collapsed entirely
    const contentRegion = document.getElementById("turn-entry-content-s1");
    expect(contentRegion).toBeNull();

    // No diff should be rendered for older turn files
    const diffs = screen.queryAllByTestId("unified-diff");
    // Only 1 diff (from the latest turn s2), not 2
    expect(diffs.length).toBeLessThanOrEqual(1);
  });

  it("auto-expands file diffs under React StrictMode (double-invoke)", async () => {
    const snapshots = [snap("s1", ["readme.md"])];

    render(
      <StrictMode>
        <TurnTimeline snapshots={snapshots} />
      </StrictMode>,
    );

    // StrictMode double-invokes effects on mount. The first invocation's
    // fetch is cancelled by cleanup; the second must start a fresh fetch
    // that completes. If the ref guard isn't reset in cleanup, the diff
    // stays stuck on loading dots forever.
    const diffEl = await screen.findByTestId("unified-diff");
    expect(diffEl).toBeTruthy();
  });
});
