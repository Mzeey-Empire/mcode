import { render, screen, waitFor } from "@testing-library/react";
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

import { mockTransport } from "@/__tests__/mocks/transport";
import { createRightPanelState, useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/features/terminal";
import { ProjectSettingsPanel } from "@/features/projects/settings/ProjectSettingsPanel";
import { branchlessThread, resetThreadOverviewState, runningActionRun } from "./__tests__/thread-overview-harness";
import { ThreadOverview } from "./ThreadOverview";

describe("ThreadOverview actions", () => {
  beforeEach(() => {
    resetThreadOverviewState();
  });

  it("starting an idle Action reveals the panel and selects its terminal tab", async () => {
    const user = userEvent.setup();
    useDiffStore.setState({
      rightPanelByThread: {
        "thread-1": createRightPanelState({
          visible: true,
          width: 380,
          tabInstances: [{ id: "singleton:preview", type: "preview" }],
          activeTabId: "singleton:preview",
        }),
      },
    });

    render(<ThreadOverview thread={branchlessThread({ mode: "direct" })} threadPaneWidth={1400} />);

    await screen.findByRole("button", { name: "Run Success" });
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    const action = await screen.findByTestId("project-action-success");
    await user.click(action);

    await waitFor(() => expect(vi.mocked(mockTransport.startWorkspaceAction)).toHaveBeenCalledWith("thread-1", "success"));
    await waitFor(() => expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      visible: true,
      activeTabId: "singleton:terminal",
      width: 600,
    }));
    expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("terminal-1");
  });

  it("refreshes the mounted Action menu after Project settings save", async () => {
    const user = userEvent.setup();
    let persisted: Awaited<ReturnType<typeof mockTransport.readWorkspaceEnvironment>> = {
      document: {
        version: "0.0.1",
        actions: [{ id: "success", name: "Success", command: { default: "bun run success" } }],
      },
      revision: "revision-1",
      status: "present",
    };
    vi.mocked(mockTransport.readWorkspaceEnvironment).mockImplementation(async () => persisted);
    vi.mocked(mockTransport.saveWorkspaceEnvironment).mockImplementation(async (
      _workspaceId,
      document,
    ) => {
      persisted = { document, revision: "revision-2", status: "present" };
      return persisted;
    });

    render(<><ThreadOverview thread={branchlessThread({ mode: "direct" })} threadPaneWidth={1400} /><ProjectSettingsPanel workspaceId="ws-1" threadId="thread-1" /></>);

    await user.click(await screen.findByRole("button", { name: /Success/, expanded: false }));
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    expect(await screen.findByRole("menuitem", { name: /Success/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const actionName = screen.getByLabelText("Action name");
    await user.clear(actionName);
    await user.type(actionName, "Renamed Action");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(vi.mocked(mockTransport.saveWorkspaceEnvironment)).toHaveBeenCalledOnce());
    await waitFor(() => expect(vi.mocked(mockTransport.readWorkspaceEnvironment)).toHaveBeenCalledTimes(3));

    await user.click(screen.getByRole("button", { name: "Project actions" }));
    expect(await screen.findByRole("menuitem", { name: /Renamed Action/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Success/ })).not.toBeInTheDocument();
  });

  it.each([
    ["a Direct Thread", { mode: "direct" }],
    ["an unmanaged Existing worktree", { mode: "worktree", worktree_managed: false }],
    ["a managed New worktree", { mode: "worktree", worktree_managed: true }],
  ] as const)("offers no manual Setup entry in the Actions menu for %s", async (_label, thread) => {
    const user = userEvent.setup();
    vi.mocked(mockTransport.readWorkspaceEnvironment).mockResolvedValue({
      document: {
        version: "0.1.0",
        actions: [{ id: "success", name: "Success", command: { default: "bun run success" }, runOnStartup: true }],
      },
      revision: null,
      status: "present",
    });
    render(<ThreadOverview thread={branchlessThread(thread)} threadPaneWidth={1400} />);

    await screen.findByRole("button", { name: "Run Success" });
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    await screen.findByRole("menuitem", { name: /Success/ });
    expect(screen.queryByRole("menuitem", { name: "Run Setup" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Edit actions" })).toBeInTheDocument();
  });

  it("runs the most recently run Action from the row's main part", async () => {
    const user = userEvent.setup();
    vi.mocked(mockTransport.readWorkspaceEnvironment).mockResolvedValue({
      document: {
        version: "0.0.1",
        actions: [
          { id: "success", name: "Success", command: { default: "bun run success" } },
          { id: "dev", name: "Dev server", command: { default: "bun run dev" } },
        ],
      },
      revision: null,
      status: "present",
    });
    vi.mocked(mockTransport.listWorkspaceActionRuns).mockResolvedValue([
      runningActionRun({ status: "completed", finishedAt: "2026-08-22T12:01:00.000Z", exitCode: 0 }),
      runningActionRun({
        actionId: "dev", actionName: "Dev server", runId: "run-2", status: "failed",
        createdAt: "2026-08-22T13:00:00.000Z", startedAt: "2026-08-22T13:00:00.000Z",
        finishedAt: "2026-08-22T13:01:00.000Z", exitCode: 1,
      }),
    ]);
    render(<ThreadOverview thread={branchlessThread({ mode: "direct" })} threadPaneWidth={1400} />);

    await user.click(await screen.findByRole("button", { name: "Run Dev server" }));

    await waitFor(() => expect(vi.mocked(mockTransport.startWorkspaceAction)).toHaveBeenCalledWith("thread-1", "dev"));
  });

  it("opens a running Action's terminal from the row instead of starting it again", async () => {
    const user = userEvent.setup();
    vi.mocked(mockTransport.listWorkspaceActionRuns).mockResolvedValue([runningActionRun()]);
    render(<ThreadOverview thread={branchlessThread({ mode: "direct" })} threadPaneWidth={1400} />);

    const row = await screen.findByRole("button", { name: "Open Success, running" });
    expect(row).toHaveTextContent("Running");
    await user.click(row);

    expect(vi.mocked(mockTransport.startWorkspaceAction)).not.toHaveBeenCalled();
    await waitFor(() => expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      visible: true,
      activeTabId: "singleton:terminal",
    }));
  });

  it("says on the row when its Action waits for approval", async () => {
    vi.mocked(mockTransport.listWorkspaceActionRuns).mockResolvedValue([runningActionRun({ status: "awaiting-approval" })]);
    render(<ThreadOverview thread={branchlessThread({ mode: "direct" })} threadPaneWidth={1400} />);

    const row = await screen.findByRole("button", { name: "Open Success, approval required" });
    expect(row).toHaveTextContent("Approval required");
    expect(row).not.toHaveTextContent("Run");
  });
});
