import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/transport", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockTransportModule(
    await importOriginal<typeof import("@/transport")>(),
  ),
);

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: vi.fn().mockReturnValue(null),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: vi.fn().mockReturnValue(null),
}));

vi.mock("@/features/projects/state/workspaceStore", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockWorkspaceStoreModule(),
);

vi.mock("@/stores/diffStore", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockDiffStoreModule(
    await importOriginal<typeof import("@/stores/diffStore")>(),
  ),
);

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

import { useOverviewStore } from "@/stores/overviewStore";
import { mockGetRightPanelVisible } from "./__tests__/thread-overview-mocks";
import { branchlessThread, resetThreadOverviewState } from "./__tests__/thread-overview-harness";
import { ThreadOverview } from "./ThreadOverview";

describe("ThreadOverview docking", () => {
  beforeEach(() => {
    resetThreadOverviewState();
  });

  it("docks the card open beside a canvas with room, and closes it from the button", async () => {
    const user = userEvent.setup();
    render(<ThreadOverview thread={branchlessThread()} threadPaneWidth={1400} />);

    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "docked");

    await user.click(screen.getByTestId("header-overview-toggle"));
    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
  });

  it("docks only from the minimum canvas width", () => {
    const overview = render(<ThreadOverview thread={branchlessThread()} threadPaneWidth={896} />);
    expect(screen.getByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "docked");

    overview.rerender(<ThreadOverview thread={branchlessThread()} threadPaneWidth={895} />);
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("gives way to the right panel and docks again when it closes", () => {
    const thread = branchlessThread();
    const overview = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    mockGetRightPanelVisible.mockReturnValue(true);
    overview.rerender(<ThreadOverview thread={thread} threadPaneWidth={1000} />);
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "false");

    mockGetRightPanelVisible.mockReturnValue(false);
    overview.rerender(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    expect(screen.getByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "docked");
  });

  it("keeps the user's close after the right panel opens and closes", async () => {
    const user = userEvent.setup();
    const thread = branchlessThread();
    const overview = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await user.click(screen.getByTestId("header-overview-toggle"));

    mockGetRightPanelVisible.mockReturnValue(true);
    overview.rerender(<ThreadOverview thread={thread} threadPaneWidth={1000} />);
    mockGetRightPanelVisible.mockReturnValue(false);
    overview.rerender(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
  });

  it("shows a requested Overview as an overlay where the card cannot dock", async () => {
    useOverviewStore.getState().requestOpen("thread-1");
    render(<ThreadOverview thread={branchlessThread()} threadPaneWidth={800} />);

    expect(await screen.findByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "overlay");
    expect(useOverviewStore.getState().requestedSubject).toBeNull();
  });
});
