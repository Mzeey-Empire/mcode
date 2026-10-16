import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { ProjectActionMenu, useProjectActions } from "../ProjectActionControl";
import { useProjectActionStore } from "../state/project-action-store";

const { transport } = vi.hoisted(() => ({
  transport: {
    readWorkspaceEnvironment: vi.fn(),
    listWorkspaceActionRuns: vi.fn(),
    restartWorkspaceAction: vi.fn(),
    stopWorkspaceAction: vi.fn(),
  },
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

const action = { id: "build", name: "Build", command: { default: "bun run build" } };

const completedRun: WorkspaceEnvironmentActionRun = {
  threadId: "thread-1",
  workspaceId: "workspace-1",
  actionId: "build",
  runId: "run-1",
  revision: 1,
  terminalSessionId: "terminal-1",
  trigger: "manual",
  port: null,
  actionName: "Build",
  status: "completed",
  snapshot: {
    platform: "windows",
    script: "bun run build",
    checkoutPath: "C:\\repo",
    terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
    environmentNames: ["PATH"],
  },
  createdAt: "2026-08-22T12:00:00.000Z",
  startedAt: "2026-08-22T12:00:00.000Z",
  finishedAt: "2026-08-22T12:00:01.000Z",
  exitCode: 0,
};

function ActionHydrationHarness() {
  const { runsByActionId } = useProjectActions("workspace-1", "thread-1");
  const build = runsByActionId.get("build")?.status ?? "missing";
  const phantom = runsByActionId.has("phantom") ? "present" : "removed";
  return <output data-testid="action-hydration-state">{`${build}:${phantom}`}</output>;
}

describe("ProjectAction controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectActionStore.setState({
      runsByThread: {},
      configurationEpochByWorkspace: {},
      updateEpochByThread: {},
      updateEpochByThreadAction: {},
      hydrationByThread: {},
    });
  });

  it("keeps a new launch in the background and focuses an already running slot", async () => {
    const user = userEvent.setup();
    const start = vi.fn().mockResolvedValue(undefined);
    const focus = vi.fn();
    const { rerender } = render(
      <ProjectActionMenu actions={[action]} runsByActionId={new Map()} onStart={start} onFocus={focus} onEdit={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Build/ }));
    expect(start).toHaveBeenCalledWith("build");
    expect(focus).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: /Build/ })).toBeInTheDocument();

    rerender(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map([["build", { ...completedRun, status: "running", finishedAt: null, exitCode: null }]])}
        onStart={start}
        onFocus={focus}
        onEdit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: /Build/ }));
    expect(focus).toHaveBeenCalledWith("build");
  });

  it("groups Edit and configured Actions in visible menu order", async () => {
    const user = userEvent.setup();
    render(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map()}
        onStart={vi.fn().mockResolvedValue(undefined)}
        onFocus={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));

    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Edit project actions",
      "Build",
    ]);
    expect(menuItems[1].lastElementChild?.querySelector('[aria-label="Play"]')).not.toBeNull();
    const content = menuItems[0].closest('[data-slot="dropdown-menu-content"]');
    expect(content?.querySelectorAll('[data-slot="dropdown-menu-separator"]')).toHaveLength(1);
  });

  it("does not create a blank Action group for an empty load error", async () => {
    const user = userEvent.setup();
    render(
      <ProjectActionMenu
        actions={[]}
        runsByActionId={new Map()}
        loadError=""
        onStart={vi.fn().mockResolvedValue(undefined)}
        onFocus={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));

    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Edit project actions",
    ]);
    const content = menuItems[0].closest('[data-slot="dropdown-menu-content"]');
    expect(content?.querySelectorAll('[data-slot="dropdown-menu-separator"]')).toHaveLength(0);
  });

  it("reports a rejected launch instead of silently discarding it", async () => {
    const user = userEvent.setup();
    render(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map()}
        onStart={vi.fn().mockRejectedValue(new Error("capacity reached"))}
        onFocus={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Build/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("Project Action could not start.");
  });

  it("opens the pending tab of an Action awaiting approval instead of starting it again", async () => {
    const user = userEvent.setup();
    const pendingRun: WorkspaceEnvironmentActionRun = {
      ...completedRun,
      status: "awaiting-approval",
      finishedAt: null,
      exitCode: null,
      snapshot: {
        ...completedRun.snapshot,
        approval: { target: { kind: "action", actionId: "build" }, fingerprint: "fingerprint-1" },
      },
    };
    const start = vi.fn();
    const focus = vi.fn();
    render(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map([["build", pendingRun]])}
        onStart={start}
        onFocus={focus}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Build/ }));

    expect(focus).toHaveBeenCalledWith("build");
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps a deleted Action row available for retained result inspection", async () => {
    const user = userEvent.setup();
    const focus = vi.fn();
    render(
      <ProjectActionMenu
        actions={[]}
        runsByActionId={new Map([["build", completedRun]])}
        onStart={vi.fn().mockResolvedValue(undefined)}
        onFocus={focus}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    expect(await screen.findByLabelText("Play")).toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: /Build/ }));

    expect(focus).toHaveBeenCalledWith("build");
  });

  it("labels the running status without visible text", async () => {
    const user = userEvent.setup();
    render(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map([["build", { ...completedRun, status: "running", finishedAt: null, exitCode: null }]])}
        onStart={vi.fn().mockResolvedValue(undefined)}
        onFocus={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));

    const running = await screen.findByRole("status", { name: "Running" });
    expect(running).not.toHaveTextContent("Running");
  });

  it("retains a post-request push while pruning a pre-request omitted phantom", async () => {
    let resolveList!: (runs: readonly WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      document: { version: "0.0.1", actions: [action] },
    });
    transport.listWorkspaceActionRuns.mockReturnValueOnce(new Promise((resolve) => {
      resolveList = resolve;
    }));
    act(() => useProjectActionStore.getState().applyRun({
      ...completedRun,
      actionId: "phantom",
      actionName: "Deleted Action",
      runId: "phantom-run",
    }));

    render(<ActionHydrationHarness />);
    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalledWith("thread-1"));

    act(() => useProjectActionStore.getState().applyRun({
      ...completedRun,
      revision: 2,
    }));
    act(() => resolveList([{
      ...completedRun,
      revision: 0,
      status: "running",
      finishedAt: null,
      exitCode: null,
    }]));

    await waitFor(() => {
      expect(screen.getByTestId("action-hydration-state")).toHaveTextContent("completed:removed");
    });
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build).toMatchObject({
      revision: 2,
      status: "completed",
    });
  });

  it("ignores an in-flight Action list after its Thread is cleared", async () => {
    let resolveList!: (runs: readonly WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      document: { version: "0.0.1", actions: [action] },
    });
    transport.listWorkspaceActionRuns.mockReturnValueOnce(new Promise((resolve) => {
      resolveList = resolve;
    }));

    render(<ActionHydrationHarness />);
    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalledWith("thread-1"));
    act(() => useProjectActionStore.getState().clearThread("thread-1"));
    await act(async () => { resolveList([completedRun]); });

    expect(useProjectActionStore.getState().runsByThread["thread-1"]).toBeUndefined();
  });

  it("does not hydrate Action state after its hook unmounts", async () => {
    let resolveList!: (runs: readonly WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      document: { version: "0.0.1", actions: [action] },
    });
    transport.listWorkspaceActionRuns.mockReturnValueOnce(new Promise((resolve) => {
      resolveList = resolve;
    }));

    const view = render(<ActionHydrationHarness />);
    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalledWith("thread-1"));
    view.unmount();
    await act(async () => { resolveList([completedRun]); });

    expect(useProjectActionStore.getState().runsByThread["thread-1"]).toBeUndefined();
  });
});
