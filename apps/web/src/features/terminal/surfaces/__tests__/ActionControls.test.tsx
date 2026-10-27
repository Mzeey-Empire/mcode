import { mockTransport } from "@/__tests__/mocks/transport";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";

const transport = {
  restartWorkspaceAction: vi.mocked(mockTransport.restartWorkspaceAction),
  stopWorkspaceAction: vi.mocked(mockTransport.stopWorkspaceAction),
  getWorkspaceActionRun: vi.mocked(mockTransport.getWorkspaceActionRun),
  terminalPause: vi.mocked(mockTransport.terminalPause),
};

const openUrlInPreview = vi.hoisted(() => vi.fn());

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.restartWorkspaceAction).mockReset();
  vi.mocked(mockTransport.stopWorkspaceAction).mockReset();
  vi.mocked(mockTransport.getWorkspaceActionRun).mockReset();
  vi.mocked(mockTransport.terminalPause).mockReset().mockResolvedValue(undefined);
});
vi.mock("@/features/preview", () => ({ openUrlInPreview }));

import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { useDiffStore } from "@/stores/diffStore";
import { useToastStore } from "@/stores/toastStore";
import { applyActionRun } from "../../state/applyActionRun";
import { ActionControls } from "../ActionControls";

const record = {
  id: "pty-1",
  threadId: "thread-1",
  label: "web",
  state: "running",
  kind: "action",
  actionId: "web",
} as TerminalInstance;

function actionRun(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "web",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "pty-1",
    trigger: "manual",
    port: null,
    actionName: "web",
    status: "running",
    snapshot: {
      platform: "linux",
      script: "bun run dev\nsecond line",
      checkoutPath: "/repo",
      terminal: null,
      environmentNames: [],
    },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function actionPort(overrides: Partial<NonNullable<WorkspaceEnvironmentActionRun["port"]>> = {}) {
  return {
    runId: "run-1",
    port: 5173,
    host: "localhost" as const,
    url: "http://localhost:5173/",
    reachable: true,
    detectedAt: "2026-08-22T12:00:02.000Z",
    ...overrides,
  };
}

const onClose = vi.fn();

function renderControls(run: WorkspaceEnvironmentActionRun | null) {
  if (run) applyActionRun(run, { focus: true });
  return render(<ActionControls workspaceId="workspace-1" threadId="thread-1" terminal={record} onClose={onClose} />);
}

describe("ActionControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.getWorkspaceActionRun.mockResolvedValue(null);
    useProjectActionStore.setState({
      runsByThread: {},
      configurationEpochByWorkspace: {},
      updateEpochByThread: {},
      updateEpochByThreadAction: {},
      hydrationByThread: {},
    });
    useTerminalStore.setState({
      terminals: {},
      activeTerminalByScope: {},
      ptyToThread: {},
    });
    useToastStore.setState({ toasts: [] });
  });

  it("shows the first line of the command and no Exit pill while it runs", () => {
    renderControls(actionRun());

    expect(screen.getByTestId("action-command-pill")).toHaveTextContent("bun run dev");
    expect(screen.getByTestId("action-command-pill")).not.toHaveTextContent("second line");
    expect(screen.queryByTestId("action-exit-pill")).not.toBeInTheDocument();
  });

  it("offers Restart and Stop while running, and no Run again", () => {
    renderControls(actionRun());

    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run again" })).not.toBeInTheDocument();
  });

  it("shows the exit code and Run again for a failed run, replacing Restart and Stop", () => {
    renderControls(actionRun({ status: "failed", exitCode: 1, finishedAt: "2026-08-22T12:00:01.000Z" }));

    expect(screen.getByTestId("action-exit-pill")).toHaveTextContent("Exit 1");
    expect(screen.getByRole("button", { name: "Run again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("shows no Exit pill for a run the user stopped", () => {
    renderControls(actionRun({ status: "interrupted", exitCode: 130, finishedAt: "2026-08-22T12:00:01.000Z" }));

    expect(screen.queryByTestId("action-exit-pill")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run again" })).toBeInTheDocument();
  });

  it("runs again in the same terminal and tab after a failure", async () => {
    const failed = actionRun({ status: "failed", exitCode: 1, finishedAt: "2026-08-22T12:00:01.000Z" });
    renderControls(failed);
    transport.restartWorkspaceAction.mockResolvedValue(actionRun({ runId: "run-2", createdAt: "2026-08-22T12:00:02.000Z" }));

    fireEvent.click(screen.getByRole("button", { name: "Run again" }));

    await waitFor(() => expect(transport.restartWorkspaceAction).toHaveBeenCalledWith("thread-1", "web"));
    await waitFor(() => expect(useProjectActionStore.getState().runsByThread["thread-1"]?.web?.runId).toBe("run-2"));
    expect(useTerminalStore.getState().terminals["thread-1"]?.map((terminal) => terminal.id)).toEqual(["pty-1"]);
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByTestId("action-exit-pill")).not.toBeInTheDocument();
  });

  it("restarts a running action through the server restart", async () => {
    renderControls(actionRun());
    transport.restartWorkspaceAction.mockResolvedValue(actionRun({ runId: "run-2", createdAt: "2026-08-22T12:00:02.000Z" }));

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() => expect(useProjectActionStore.getState().runsByThread["thread-1"]?.web?.runId).toBe("run-2"));
    expect(transport.stopWorkspaceAction).not.toHaveBeenCalled();
  });

  it("stops a running action and shows Run again with the stopped result", async () => {
    renderControls(actionRun());
    transport.stopWorkspaceAction.mockResolvedValue(
      actionRun({ revision: 1, status: "interrupted", finishedAt: "2026-08-22T12:00:03.000Z", exitCode: 130 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(await screen.findByRole("button", { name: "Run again" })).toBeInTheDocument();
    expect(transport.stopWorkspaceAction).toHaveBeenCalledWith("thread-1", "web");
  });

  it("keeps the running controls and reports a stop that failed", async () => {
    renderControls(actionRun());
    transport.stopWorkspaceAction.mockRejectedValue(new Error("cleanup failed"));

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "failed", meta: "cleanup failed" });
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("fetches the retained run when a rebuilt record has none in the store yet", async () => {
    transport.getWorkspaceActionRun.mockResolvedValue(actionRun());
    renderControls(null);

    expect(await screen.findByTestId("action-command-pill")).toHaveTextContent("bun run dev");
    expect(transport.getWorkspaceActionRun).toHaveBeenCalledWith("thread-1", "web");
  });

  it("reports a hydration failure instead of leaving row 2 empty without a reason", async () => {
    transport.getWorkspaceActionRun.mockRejectedValue(new Error("offline"));
    renderControls(null);

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "failed", meta: "offline" });
  });

  it("shows no port pill until the run's output announced a port", () => {
    renderControls(actionRun());

    expect(screen.queryByTestId("action-port-pill")).not.toBeInTheDocument();
  });

  it("shows a live port pill that opens the URL in the Browser tab", async () => {
    const user = userEvent.setup();
    renderControls(actionRun({ port: actionPort() }));

    const pill = screen.getByTestId("action-port-pill");
    expect(pill).toHaveTextContent(":5173");
    expect(pill).toHaveAttribute("data-live", "true");
    await user.click(pill);

    await waitFor(() => expect(openUrlInPreview).toHaveBeenCalledWith({ url: "http://localhost:5173/", threadId: "thread-1" }));
  });

  it("says only that TCP accepts connections, never that the page works", async () => {
    const user = userEvent.setup();
    renderControls(actionRun({ port: actionPort() }));

    await user.hover(screen.getByTestId("action-port-pill"));

    expect(await screen.findByText("Accepting connections on localhost:5173")).toBeInTheDocument();
  });

  it("keeps the port as history once the run is stopped and nothing accepts connections", async () => {
    const user = userEvent.setup();
    renderControls(
      actionRun({
        status: "interrupted",
        exitCode: 130,
        finishedAt: "2026-08-22T12:00:03.000Z",
        port: actionPort({ reachable: false }),
      }),
    );

    const pill = screen.getByTestId("action-port-pill");
    expect(pill).toHaveAttribute("data-live", "false");
    await user.hover(pill);
    expect(await screen.findByText("Not accepting connections on localhost:5173")).toBeInTheDocument();
  });

  it("treats a previous run's port as history even if it was last seen reachable", () => {
    renderControls(actionRun({ runId: "run-2", port: actionPort({ runId: "run-1", reachable: true }) }));

    expect(screen.getByTestId("action-port-pill")).toHaveAttribute("data-live", "false");
  });

  it("names the loopback address the URL printed, not the host the server listens on", async () => {
    const user = userEvent.setup();
    renderControls(actionRun({ port: actionPort({ host: "::", url: "http://localhost:5173/" }) }));

    await user.hover(screen.getByTestId("action-port-pill"));

    expect(await screen.findByText("Accepting connections on localhost:5173")).toBeInTheDocument();
  });

  it("follows a run from detection through exit and restart without remounting", () => {
    renderControls(actionRun());
    expect(screen.queryByTestId("action-port-pill")).not.toBeInTheDocument();

    act(() => applyActionRun(actionRun({ revision: 1, port: actionPort() }), { focus: false }));
    expect(screen.getByTestId("action-port-pill")).toHaveAttribute("data-live", "true");

    act(() => applyActionRun(actionRun({ revision: 2, port: actionPort({ reachable: false }) }), { focus: false }));
    expect(screen.getByTestId("action-port-pill")).toHaveAttribute("data-live", "false");

    act(() =>
      applyActionRun(
        actionRun({
          revision: 3,
          status: "failed",
          exitCode: 1,
          finishedAt: "2026-08-22T12:00:03.000Z",
          port: actionPort({ reachable: false }),
        }),
        { focus: false },
      ),
    );
    expect(screen.getByTestId("action-port-pill")).toHaveTextContent(":5173");
    expect(screen.getByTestId("action-exit-pill")).toHaveTextContent("Exit 1");

    act(() =>
      applyActionRun(
        actionRun({
          runId: "run-2",
          revision: 0,
          createdAt: "2026-08-22T12:00:04.000Z",
          port: actionPort({ runId: "run-1", reachable: false }),
        }),
        { focus: false },
      ),
    );
    expect(screen.getByTestId("action-port-pill")).toHaveAttribute("data-live", "false");
    expect(screen.queryByTestId("action-exit-pill")).not.toBeInTheDocument();
  });

  it("Close terminal in the More menu asks the owner to close this record", async () => {
    const user = userEvent.setup();
    renderControls(actionRun());

    await user.click(screen.getByRole("button", { name: "More terminal actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Close terminal" }));

    expect(onClose).toHaveBeenCalledWith("pty-1");
  });

  it("Edit action opens the Project settings tab in the right panel", async () => {
    const setRightPanelTab = vi.spyOn(useDiffStore.getState(), "setRightPanelTab");
    const user = userEvent.setup();
    renderControls(actionRun());

    await user.click(screen.getByRole("button", { name: "More terminal actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit action" }));

    expect(setRightPanelTab).toHaveBeenCalledWith("workspace-1", "thread-1", "environment");
  });
});
