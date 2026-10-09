import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import { CumulativeView } from "../CumulativeView";

vi.mock("../SummaryView", () => ({
  SummaryView: () => <div data-testid="summary-lens">Summary lens</div>,
}));

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({
    getSnapshotDiffStats: vi.fn().mockResolvedValue([]),
    listSnapshots: vi.fn().mockResolvedValue([]),
  }),
}));

describe("CumulativeView summary lens", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        diffSummary: { enabled: true },
      },
    });
  });

  it("toggles the Cumulative diff into its summary lens in place", async () => {
    render(
      <CumulativeView
        threadId="thread-1"
        comparison={{
          files: [{ path: "apps/web/src/a.ts", previousPath: null, changeType: "modified", binary: false, additions: null, deletions: null, untracked: false }],
          additions: 1,
          deletions: 0,
        }}
        cacheVersion="snap-1"
      />,
    );

    expect(screen.getByTestId("review-file-jump-trigger")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("cumulative-summary-toggle"));

    expect(screen.getByTestId("summary-lens")).toBeInTheDocument();
    expect(screen.queryByTestId("review-file-jump-trigger")).not.toBeInTheDocument();
  });

  it("hides the summary lens toggle when the setting is disabled", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        diffSummary: { enabled: false },
      },
    });

    render(
      <CumulativeView
        threadId="thread-1"
        comparison={{
          files: [{ path: "apps/web/src/a.ts", previousPath: null, changeType: "modified", binary: false, additions: null, deletions: null, untracked: false }],
          additions: 1,
          deletions: 0,
        }}
        cacheVersion="snap-1"
      />,
    );

    expect(screen.queryByTestId("cumulative-summary-toggle")).not.toBeInTheDocument();
  });
});
