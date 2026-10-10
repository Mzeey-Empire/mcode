import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CumulativeView } from "../CumulativeView";

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({
    getCumulativeDiff: vi.fn().mockResolvedValue(""),
    listSnapshots: vi.fn().mockResolvedValue([]),
  }),
}));

const comparison = {
  files: [{ path: "apps/web/src/a.ts", previousPath: null, changeType: "modified" as const, binary: false, additions: null, deletions: null, untracked: false }],
  additions: 1,
  deletions: 0,
};

describe("CumulativeView", () => {
  it("renders the thread's files with no banner or summary lens", () => {
    render(<CumulativeView threadId="thread-1" comparison={comparison} cacheVersion="snap-1" refreshing={false} onRefresh={vi.fn()} />);

    expect(screen.getByTestId("review-file-jump-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("cumulative-view-refresh")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cumulative-summary-toggle")).not.toBeInTheDocument();
  });

  it("keeps the files on screen while a refresh is in flight", () => {
    render(<CumulativeView threadId="thread-1" comparison={comparison} cacheVersion="snap-1" refreshing onRefresh={vi.fn()} />);

    expect(screen.getByTestId("review-file-jump-trigger")).toBeInTheDocument();
  });
});
