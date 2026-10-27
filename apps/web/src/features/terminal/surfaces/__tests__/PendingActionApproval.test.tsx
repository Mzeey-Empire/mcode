import { mockTransport } from "@/__tests__/mocks/transport";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";

const approveWorkspaceEnvironmentCommand = vi.mocked(mockTransport.approveWorkspaceEnvironmentCommand);
const startWorkspaceAction = vi.mocked(mockTransport.startWorkspaceAction);
const terminalKill = vi.mocked(mockTransport.terminalKill);

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

beforeEach(() => {
  vi.mocked(mockTransport.approveWorkspaceEnvironmentCommand).mockReset();
  vi.mocked(mockTransport.startWorkspaceAction).mockReset();
  vi.mocked(mockTransport.terminalKill).mockReset();
  vi.mocked(mockTransport.terminalPause).mockReset().mockResolvedValue(undefined);
});

import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { useToastStore } from "@/stores/toastStore";
import { PendingActionApproval } from "../PendingActionApproval";

const approval = { target: { kind: "action" as const, actionId: "web" }, fingerprint: "fingerprint-1" };

function run(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "web",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "pty-1",
    trigger: "manual",
    actionName: "web",
    status: "awaiting-approval",
    snapshot: { platform: "linux", script: "bun run dev", checkoutPath: "/repo", terminal: null, environmentNames: [], approval },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    port: null,
    ...overrides,
  };
}

/** Starting an awaiting Action creates a new run on the same terminal, as the server does. */
function started(): WorkspaceEnvironmentActionRun {
  return run({ runId: "run-2", status: "running", createdAt: "2026-08-22T12:00:01.000Z", startedAt: "2026-08-22T12:00:01.000Z" });
}

function seed(current: WorkspaceEnvironmentActionRun, state: "pending" | "running" = "pending"): void {
  useProjectActionStore.getState().applyRun(current);
  const record = { id: "pty-1", threadId: "thread-1", label: "web", state, kind: "action", actionId: "web" } as TerminalInstance;
  useTerminalStore.setState({
    terminals: { "thread-1": [record] },
    activeTerminalByScope: { "thread-1": "pty-1" },
    ptyToThread: { "pty-1": "thread-1" },
  });
}

const surface = <PendingActionApproval workspaceId="workspace-1" threadId="thread-1" scopeId="thread-1" />;

describe("PendingActionApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approveWorkspaceEnvironmentCommand.mockResolvedValue(undefined);
    terminalKill.mockResolvedValue(undefined);
    useProjectActionStore.setState({ runsByThread: {} });
    useToastStore.setState({ toasts: [] });
  });

  it("shows the card for the active pending terminal and nothing once the run is running", () => {
    seed(run());
    const { container, rerender } = render(surface);
    expect(screen.getByText("Run web?")).toBeInTheDocument();

    act(() => seed(started(), "running"));
    rerender(surface);

    expect(container).toBeEmptyDOMElement();
  });

  it("approves the exact fingerprint, then starts the action in the same terminal", async () => {
    const order: string[] = [];
    approveWorkspaceEnvironmentCommand.mockImplementation(async () => void order.push("approve"));
    startWorkspaceAction.mockImplementation(async () => {
      order.push("start");
      return started();
    });
    seed(run());
    render(surface);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(useTerminalStore.getState().terminals["thread-1"]?.[0]?.state).toBe("running"));
    expect(approveWorkspaceEnvironmentCommand).toHaveBeenCalledWith("thread-1", approval.target, approval.fingerprint);
    expect(startWorkspaceAction).toHaveBeenCalledWith("thread-1", "web", "run-1");
    expect(order).toEqual(["approve", "start"]);
    expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
  });

  it("starts anyway when the approval is stale, and shows the renewed command", async () => {
    approveWorkspaceEnvironmentCommand.mockRejectedValue({ code: "WORKSPACE_ENVIRONMENT_APPROVAL_STALE" });
    startWorkspaceAction.mockResolvedValue(
      run({ runId: "run-2", createdAt: "2026-08-22T12:00:01.000Z", snapshot: { ...run().snapshot, script: "bun run dev --fresh", approval: { ...approval, fingerprint: "fingerprint-2" } } }),
    );
    seed(run());
    render(surface);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("bun run dev --fresh")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The command changed. Review the updated command before running it.");
  });

  it("keeps the card and reports a failed approval", async () => {
    approveWorkspaceEnvironmentCommand.mockRejectedValue(new Error("offline"));
    seed(run());
    render(surface);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "failed", title: "Couldn't run web. Try again." }),
    );
    expect(startWorkspaceAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it("stays quiet when the server reports the tab was closed while the approval was in flight", async () => {
    let finishApproval: () => void = () => {};
    approveWorkspaceEnvironmentCommand.mockReturnValue(new Promise<void>((resolve) => (finishApproval = resolve)));
    startWorkspaceAction.mockRejectedValue({ code: "WORKSPACE_ENVIRONMENT_RUN_CLOSED" });
    seed(run());
    render(surface);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    act(() => useTerminalStore.getState().removeTerminal("pty-1"));
    await act(async () => finishApproval());

    expect(startWorkspaceAction).toHaveBeenCalledWith("thread-1", "web", "run-1");
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useTerminalStore.getState().terminals["thread-1"] ?? []).toEqual([]);
  });

  it("keeps a request in flight for one pending tab from disabling the next tab's card", async () => {
    approveWorkspaceEnvironmentCommand.mockReturnValue(new Promise<void>(() => {}));
    const other = run({ actionId: "db", actionName: "db", runId: "run-db", terminalSessionId: "pty-2", snapshot: { ...run().snapshot, script: "bun run db" } });
    seed(run());
    useProjectActionStore.getState().applyRun(other);
    const records = [
      { id: "pty-1", threadId: "thread-1", label: "web", state: "pending", kind: "action", actionId: "web" },
      { id: "pty-2", threadId: "thread-1", label: "db", state: "pending", kind: "action", actionId: "db" },
    ] as TerminalInstance[];
    act(() => useTerminalStore.setState({ terminals: { "thread-1": records }, ptyToThread: { "pty-1": "thread-1", "pty-2": "thread-1" } }));
    render(surface);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

    act(() => useTerminalStore.getState().setActiveTerminal("thread-1", "pty-2"));

    expect(await screen.findByText("Run db?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("Cancel kills the pending terminal and removes its record without approving", async () => {
    seed(run());
    render(surface);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-1"));
    await waitFor(() => expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined());
    expect(approveWorkspaceEnvironmentCommand).not.toHaveBeenCalled();
    expect(startWorkspaceAction).not.toHaveBeenCalled();
  });
});
