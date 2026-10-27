import { mockTransport } from "@/__tests__/mocks/transport";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { useProjectActionStore } from "../../environment/state/project-action-store";
import { useProjectActions } from "../useProjectActions";

const transport = {
  readWorkspaceEnvironment: vi.mocked(mockTransport.readWorkspaceEnvironment),
  listWorkspaceActionRuns: vi.mocked(mockTransport.listWorkspaceActionRuns),
  restartWorkspaceAction: vi.mocked(mockTransport.restartWorkspaceAction),
  stopWorkspaceAction: vi.mocked(mockTransport.stopWorkspaceAction),
};

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.readWorkspaceEnvironment).mockReset();
  vi.mocked(mockTransport.listWorkspaceActionRuns).mockReset();
  vi.mocked(mockTransport.restartWorkspaceAction).mockReset();
  vi.mocked(mockTransport.stopWorkspaceAction).mockReset();
});

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

describe("useProjectActions", () => {
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

  it("retains a post-request push while pruning a pre-request omitted phantom", async () => {
    let resolveList!: (runs: WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      revision: "revision-1", status: "present",
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
    let resolveList!: (runs: WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      revision: "revision-1", status: "present",
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
    let resolveList!: (runs: WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      revision: "revision-1", status: "present",
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
