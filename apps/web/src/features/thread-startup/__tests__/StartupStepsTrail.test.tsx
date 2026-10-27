import { mockTransport } from "@/__tests__/mocks/transport";
import type { ThreadStartup, ThreadStartupAction, ThreadStartupStep } from "@mcode/contracts/thread-startup";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const startupTransport = {
  cancelThreadStartup: vi.mocked(mockTransport.cancelThreadStartup),
  retryAutomaticSetup: vi.mocked(mockTransport.retryAutomaticSetup),
  continueAutomaticSetup: vi.mocked(mockTransport.continueAutomaticSetup),
  approveWorkspaceEnvironmentCommand: vi.mocked(mockTransport.approveWorkspaceEnvironmentCommand),
  startWorkspaceAction: vi.mocked(mockTransport.startWorkspaceAction),
  resolveThreadStartup: vi.mocked(mockTransport.resolveThreadStartup),
  listWorkspaceActionRuns: vi.mocked(mockTransport.listWorkspaceActionRuns),
};

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

beforeEach(() => {
  vi.mocked(mockTransport.cancelThreadStartup).mockReset();
  vi.mocked(mockTransport.retryAutomaticSetup).mockReset();
  vi.mocked(mockTransport.continueAutomaticSetup).mockReset();
  vi.mocked(mockTransport.approveWorkspaceEnvironmentCommand).mockReset();
  vi.mocked(mockTransport.startWorkspaceAction).mockReset();
  vi.mocked(mockTransport.resolveThreadStartup).mockReset();
  vi.mocked(mockTransport.listWorkspaceActionRuns).mockReset();
});

import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { StartupStepsTrail } from "../StartupStepsTrail";
import { useThreadStartupStore } from "../state/thread-startup-store";

const startupId = "00000000-0000-4000-8000-000000000001";
const T0 = "2026-09-02T12:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1_000).toISOString();

function startup(overrides: Partial<ThreadStartup> = {}): ThreadStartup {
  return {
    startupId,
    workspaceId: "workspace-1",
    kind: "managed-worktree",
    state: "running",
    phase: "setup",
    steps: [
      { phase: "thread", state: "completed", startedAt: at(0), endedAt: at(0) },
      { phase: "worktree", state: "completed", startedAt: at(0), endedAt: at(2), detail: { phase: "worktree", mode: "created", folderName: "mcode-3f2a", path: "/w/mcode-3f2a" } },
      setupStep("running", "running"),
      { phase: "agent", state: "pending" },
    ],
    transcript: [],
    cancellation: "none",
    revision: 1,
    threadId: "thread-1",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const approval = { target: { kind: "action" as const, actionId: "install" }, fingerprint: "fp-1" };

function installAction(outcome: ThreadStartupAction["outcome"]): ThreadStartupAction {
  return { actionId: "install", scriptHash: "a".repeat(64), runId: "run-1", outcome };
}

function setupStep(state: ThreadStartupStep["state"], outcome: ThreadStartupAction["outcome"], times: Partial<ThreadStartupStep> = {}): ThreadStartupStep {
  return { phase: "setup", state, startedAt: at(2), ...times, detail: { phase: "setup", actions: [installAction(outcome)] } };
}

function seedRun(script: string, overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  const run: WorkspaceEnvironmentActionRun = {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "install",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "pty-1",
    trigger: "startup",
    actionName: "Install",
    status: "running",
    snapshot: { platform: "linux", script, checkoutPath: "/repo", terminal: null, environmentNames: [] },
    createdAt: at(2),
    startedAt: at(2),
    finishedAt: null,
    exitCode: null,
    port: null,
    ...overrides,
  };
  useProjectActionStore.getState().applyRun(run);
  return run;
}

function seedPendingTab(): void {
  const tab = { id: "pty-1", threadId: "thread-1", label: "Install", state: "pending", kind: "action", actionId: "install" } as TerminalInstance;
  useTerminalStore.setState({
    terminals: { "thread-1": [tab] },
    activeTerminalByScope: { "thread-1": "pty-1" },
    ptyToThread: { "pty-1": "thread-1" },
  });
}

function renderTrail(props: Parameters<typeof StartupStepsTrail>[0]) {
  return render(<TooltipProvider><StartupStepsTrail {...props} /></TooltipProvider>);
}

function rowLabels() {
  return screen.getAllByTestId(/^startup-step-/).map((row) => [row.dataset.testid, row.dataset.tone, row.textContent]);
}

describe("StartupStepsTrail", () => {
  beforeEach(() => {
    const gate = { gate: "not-required" as const, attempt: null, queuedTurns: [] };
    startupTransport.retryAutomaticSetup.mockResolvedValue(gate);
    startupTransport.continueAutomaticSetup.mockResolvedValue(gate);
    startupTransport.approveWorkspaceEnvironmentCommand.mockResolvedValue(undefined);
    startupTransport.resolveThreadStartup.mockResolvedValue(startup({ revision: 9 }));
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const mock of Object.values(startupTransport)) mock.mockReset();
    useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {} });
    useProjectActionStore.setState({ runsByThread: {} });
    useTerminalStore.setState({ terminals: {}, activeTerminalByScope: {}, ptyToThread: {} });
    useConnectionStore.setState({ status: "connecting" });
  });

  it("draws pending placeholder rows before the record arrives", () => {
    renderTrail({ kind: "managed-worktree" });
    expect(rowLabels()).toEqual([
      ["startup-step-worktree", "pending", "Create worktree"],
      ["startup-step-setup", "pending", "Run setup"],
      ["startup-step-agent", "pending", "Start thread"],
    ]);
    expect(screen.queryByTestId("startup-step-thread")).toBeNull();
  });

  it("ticks the live row and labels it with the running action's first script line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(at(5)) });
    seedRun("bun install\nbun run build");
    renderTrail({ startup: startup(), kind: "managed-worktree" });

    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("Running setupbun install3s");
    expect(screen.getByTestId("startup-step-worktree")).toHaveTextContent("Created worktreemcode-3f2a2s");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("5s");
  });

  it("labels the live row with the action now running, not the first one", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(at(5)) });
    seedRun("bun install", { status: "completed", exitCode: 0 });
    seedRun("bun check", { actionId: "check", runId: "run-2", terminalSessionId: "pty-2" });
    const actions = [installAction("ready"), { ...installAction("running"), actionId: "check", runId: "run-2" }];
    const step = { ...setupStep("running", "running"), detail: { phase: "setup" as const, actions } };
    renderTrail({ startup: startup({ steps: [{ phase: "thread", state: "completed" }, step, { phase: "agent", state: "pending" }] }), kind: "managed-worktree" });

    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("bun check");
  });

  it("reads the retained runs again on reconnect so a missed approval can be run", async () => {
    const waiting = { ...seedRun("bun install", { status: "awaiting-approval" }), runId: "run-1" };
    useProjectActionStore.setState({ runsByThread: {} });
    startupTransport.listWorkspaceActionRuns.mockResolvedValue([waiting]);
    renderTrail({
      startup: startup({
        state: "blocked",
        steps: [{ phase: "thread", state: "completed" }, setupStep("blocked", "pending"), { phase: "agent", state: "pending" }],
        block: { code: "SETUP_APPROVAL_REQUIRED", message: "Setup needs approval", actions: ["retry", "continue"] },
      }),
      kind: "managed-worktree",
    });
    expect(startupTransport.listWorkspaceActionRuns).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run setup" })).toBeDisabled();

    act(() => useConnectionStore.setState({ status: "connected" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run setup" })).toBeEnabled());
    expect(startupTransport.listWorkspaceActionRuns).toHaveBeenCalledWith("thread-1");
  });

  it("labels the row once the run reaches the store, and ignores a run the sequence did not launch", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(at(3)) });
    renderTrail({ startup: startup(), kind: "managed-worktree" });
    expect(screen.getByTestId("startup-step-setup")).not.toHaveTextContent("bun install");

    act(() => { seedRun("bun install", { runId: "manual-run" }); });
    expect(screen.getByTestId("startup-step-setup")).not.toHaveTextContent("bun install");

    act(() => { seedRun("bun install"); });
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("bun install");
  });

  it("expands the live setup row into the script and output tail", async () => {
    seedRun("bun install");
    renderTrail({
      startup: startup({
        transcript: [
          { phase: "worktree", content: "Preparing worktree\n", createdAt: at(1) },
          { phase: "setup", content: "$ bun install\nresolved 412 packages\n", createdAt: at(3) },
        ],
      }),
      kind: "managed-worktree",
      onOpenTerminal: vi.fn(),
      onEditScript: vi.fn(),
    });

    expect(screen.queryByTestId("startup-setup-output")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show setup output" }));

    const log = screen.getByRole("log", { name: "Setup output" });
    expect(Array.from(log.children, (line) => line.textContent).filter(Boolean)).toEqual(["$ bun install", "resolved 412 packages"]);
    await waitFor(() => expect(screen.getByTestId("startup-setup-output")).toHaveTextContent("$ bun install"));
    expect(screen.getByRole("button", { name: "Open terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit script" })).toBeInTheDocument();
  });

  it("shows a failed step with its exit code, detail and actions", () => {
    seedRun("bun install", { status: "completed", exitCode: 1 });
    renderTrail({
      startup: startup({
        state: "failed",
        steps: [
          { phase: "thread", state: "completed" },
          { phase: "worktree", state: "completed", startedAt: at(0), endedAt: at(2), detail: { phase: "worktree", mode: "created", folderName: "mcode-3f2a", path: "/w" } },
          { ...setupStep("failed", "failed", { endedAt: at(16) }), detail: { phase: "setup", actions: [installAction("failed")], exitCode: 1 } },
          { phase: "agent", state: "pending" },
        ],
        error: { code: "SETUP_FAILED", message: "Setup failed", retryable: true, detail: "error: lockfile had changes" },
      }),
      kind: "managed-worktree",
      actions: <button type="button">Retry setup</button>,
    });

    expect(screen.getByTestId("startup-step-setup")).toHaveAttribute("data-tone", "failed");
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("Setup failedexit 1 · 14s");
    expect(screen.getByTestId("startup-detail")).toHaveTextContent("error: lockfile had changes");
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("offers Retry setup, Skip setup and Show output for a setup that failed, without Cancel", async () => {
    seedRun("bun install", { status: "completed", exitCode: 1 });
    const onOpenTerminal = vi.fn();
    renderTrail({
      startup: startup({
        state: "blocked",
        steps: [
          { phase: "thread", state: "completed" },
          { ...setupStep("blocked", "failed", { endedAt: at(16) }), detail: { phase: "setup", actions: [installAction("failed")], exitCode: 1 } },
          { phase: "agent", state: "pending" },
        ],
        transcript: [{ phase: "setup", content: "$ bun install\nerror: lockfile had changes\n", createdAt: at(3) }],
        block: { code: "SETUP_FAILED", message: "Project Setup did not complete successfully", actions: ["retry", "continue"], detail: "error: lockfile had changes" },
      }),
      kind: "managed-worktree",
      onOpenTerminal,
    });

    expect(screen.getByTestId("startup-step-setup")).toHaveAttribute("data-tone", "failed");
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("Setup failedexit 1 · 14s");
    expect(screen.getByRole("alert")).toHaveTextContent("error: lockfile had changes");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(screen.getByRole("log", { name: "Setup output" })).toHaveTextContent("error: lockfile had changes");
    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(onOpenTerminal).toHaveBeenCalledWith("pty-1");
    expect(screen.getByRole("button", { name: "Hide output" })).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(startupTransport.retryAutomaticSetup).toHaveBeenCalledWith("thread-1");
    await userEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(startupTransport.continueAutomaticSetup).toHaveBeenCalledWith("thread-1");
  });

  it("lets the user skip a running setup that never exits, beside Cancel", async () => {
    seedRun("bun run dev", { status: "running" });
    renderTrail({ startup: startup(), kind: "managed-worktree" });

    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(startupTransport.continueAutomaticSetup).toHaveBeenCalledWith("thread-1");
  });

  it("offers no Skip setup before setup starts", () => {
    renderTrail({ startup: startup({ phase: "worktree", steps: [{ phase: "thread", state: "completed" }, { phase: "worktree", state: "running", startedAt: at(0) }, { phase: "setup", state: "pending" }, { phase: "agent", state: "pending" }] }), kind: "managed-worktree" });
    expect(screen.queryByRole("button", { name: "Skip setup" })).toBeNull();
  });

  it("asks to run a shared setup with its command, then approves and starts the action", async () => {
    const pending = seedRun("bun install\nbun run build", {
      status: "awaiting-approval",
      startedAt: null,
      snapshot: { platform: "linux", script: "bun install\nbun run build", checkoutPath: "/repo", terminal: null, environmentNames: [], approval },
    });
    seedPendingTab();
    startupTransport.startWorkspaceAction.mockResolvedValue({ ...pending, runId: "run-2", status: "running" });
    renderTrail({
      startup: startup({
        state: "blocked",
        steps: [
          { phase: "thread", state: "completed" },
          setupStep("blocked", "pending"),
          { phase: "agent", state: "pending" },
        ],
        block: { code: "SETUP_APPROVAL_REQUIRED", message: "Setup needs approval", actions: ["retry", "continue"] },
      }),
      kind: "managed-worktree",
    });

    expect(screen.getByTestId("startup-step-setup")).toHaveAttribute("data-tone", "approval");
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent(/^Setup needs approval$/);
    expect(screen.getByRole("status")).toHaveTextContent("Setup needs approval");
    expect(screen.getByTestId("startup-detail").textContent).toBe("$ bun install\nbun run build");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Run setup" }));
    await waitFor(() => expect(startupTransport.startWorkspaceAction).toHaveBeenCalledWith("thread-1", "install", pending.runId));
    expect(startupTransport.approveWorkspaceEnvironmentCommand).toHaveBeenCalledWith("thread-1", approval.target, "fp-1");
    await userEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(startupTransport.continueAutomaticSetup).toHaveBeenCalledWith("thread-1");
  });

  it("sets the decision under the step it stopped at, above the steps still pending", () => {
    renderTrail({
      startup: startup({
        state: "blocked",
        steps: [
          { phase: "thread", state: "completed" },
          { phase: "setup", state: "blocked", startedAt: at(2), endedAt: at(16), detail: { phase: "setup", exitCode: 1 } },
          { phase: "agent", state: "pending" },
        ],
        block: { code: "SETUP_FAILED", message: "Project Setup did not complete successfully", actions: ["retry", "continue"], detail: "error: lockfile had changes" },
      }),
      kind: "managed-worktree",
    });
    const order = Array.from(screen.getByTestId("startup-trail").querySelectorAll("[data-testid]"), (node) => node.getAttribute("data-testid"));
    expect(order).toEqual(["startup-step-setup", "startup-detail", "startup-actions", "startup-step-agent"]);
  });

  it("keeps the other setup actions disabled while one is on its way, and the pending one focusable", async () => {
    startupTransport.retryAutomaticSetup.mockReturnValue(new Promise(() => undefined));
    renderTrail({
      startup: startup({
        state: "blocked",
        steps: [{ phase: "thread", state: "completed" }, { phase: "setup", state: "blocked", startedAt: at(2), endedAt: at(16) }],
        block: { code: "SETUP_FAILED", message: "Project Setup did not complete successfully", actions: ["retry", "continue"] },
      }),
      kind: "managed-worktree",
    });
    await userEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(screen.getByRole("button", { name: "Retry setup" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Retry setup" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip setup" })).toBeDisabled();
  });

  it("disables Run setup until the pending action run has loaded, and says why", async () => {
    renderTrail({
      startup: startup({
        state: "blocked",
        steps: [{ phase: "thread", state: "completed" }, setupStep("blocked", "pending")],
        block: { code: "SETUP_APPROVAL_REQUIRED", message: "Setup needs approval", actions: ["retry", "continue"] },
      }),
      kind: "managed-worktree",
    });

    expect(screen.getByTestId("startup-detail")).toHaveTextContent("Setup needs approval");
    expect(screen.getByRole("button", { name: "Run setup" })).toBeDisabled();
    expect(startupTransport.approveWorkspaceEnvironmentCommand).not.toHaveBeenCalled();

    act(() => {
      seedRun("bun install", {
        status: "awaiting-approval",
        snapshot: { platform: "linux", script: "bun install", checkoutPath: "/repo", terminal: null, environmentNames: [], approval },
      });
    });
    expect(screen.getByRole("button", { name: "Run setup" })).toBeEnabled();
    expect(screen.getByTestId("startup-detail")).toHaveTextContent("$ bun install");
  });

  it("offers Retry and Start from local for a failed origin fetch, without Cancel", async () => {
    renderTrail({
      startup: startup({
        state: "blocked",
        phase: "fetch",
        steps: [
          { phase: "fetch", state: "blocked", startedAt: at(0), endedAt: at(3), detail: { phase: "fetch", ref: "origin/main", branch: "main" } },
          { phase: "thread", state: "pending" },
          { phase: "worktree", state: "pending" },
        ],
        block: { code: "start_from_origin_failed", message: "Could not fetch origin/main", actions: ["retry", "continue"] },
      }),
      kind: "managed-worktree",
    });

    expect(screen.getByTestId("startup-detail")).toHaveTextContent("Could not fetch origin/main");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start from local main" }));
    expect(startupTransport.resolveThreadStartup).toHaveBeenCalledWith(startupId, "continue");
  });

  it("shows only the current attempt's output after Retry setup", async () => {
    const failedOutput = { phase: "setup" as const, content: "error: lockfile had changes\n", createdAt: at(3) };
    const retried = (transcript: ThreadStartup["transcript"]) => startup({ steps: [
      { phase: "thread", state: "completed" },
      { phase: "setup", state: "running", startedAt: at(20) },
    ], transcript });
    const { rerender } = renderTrail({ startup: retried([failedOutput]), kind: "managed-worktree" });
    await userEvent.click(screen.getByRole("button", { name: "Show setup output" }));
    expect(screen.getByRole("log", { name: "Setup output" })).toHaveTextContent(/^$/);

    rerender(<TooltipProvider><StartupStepsTrail startup={retried([failedOutput, { phase: "setup", content: "resolved 412 packages\n", createdAt: at(21) }])} kind="managed-worktree" /></TooltipProvider>);
    expect(screen.getByRole("log", { name: "Setup output" })).toHaveTextContent(/^resolved 412 packages$/);
  });

  it("explains a block with its message when the server has no output line to show", () => {
    renderTrail({
      startup: startup({
        state: "blocked",
        steps: [{ phase: "thread", state: "completed" }, { phase: "setup", state: "blocked", startedAt: at(2), endedAt: at(2) }],
        block: { code: "SETUP_UNAVAILABLE", message: "Project Setup could not start", actions: ["retry", "continue"] },
      }),
      kind: "managed-worktree",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Project Setup could not start");
  });

  it("announces state changes without the ticking duration", () => {
    const { rerender } = renderTrail({ kind: "managed-worktree" });
    expect(screen.getByRole("status")).toHaveTextContent(/^Preparing thread$/);

    rerender(<TooltipProvider><StartupStepsTrail startup={startup()} kind="managed-worktree" /></TooltipProvider>);
    expect(screen.getByRole("status")).toHaveTextContent(/^Running setup$/);
  });

  it("shows skipped setup and an opened worktree without durations", () => {
    renderTrail({
      startup: startup({
        kind: "attached-worktree",
        state: "running",
        phase: "agent",
        steps: [
          { phase: "thread", state: "completed" },
          { phase: "worktree", state: "completed", startedAt: at(0), endedAt: at(3), detail: { phase: "worktree", mode: "opened", folderName: "mcode-9c1d", path: "/w/mcode-9c1d" } },
          { phase: "setup", state: "skipped", startedAt: at(3), endedAt: at(3), detail: { phase: "setup", skipReason: "thread-running-here" } },
          { phase: "agent", state: "running", startedAt: at(3) },
        ],
      }),
      kind: "attached-worktree",
    });
    expect(screen.getByTestId("startup-step-worktree")).toHaveTextContent(/^Opened worktreemcode-9c1d$/);
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent(/^Skipped setupthread running here$/);
  });

  it("renders nothing once the startup has completed", () => {
    seedRun("bun install", { status: "completed", exitCode: 0 });
    const { container } = renderTrail({
      startup: startup({
        state: "completed",
        phase: "agent",
        steps: [
          { phase: "thread", state: "completed" },
          { phase: "worktree", state: "completed", startedAt: at(0), endedAt: at(2), detail: { phase: "worktree", mode: "created", folderName: "mcode-3f2a", path: "/w" } },
          setupStep("completed", "ready", { endedAt: at(14) }),
          { phase: "agent", state: "completed", startedAt: at(14), endedAt: at(22) },
        ],
        updatedAt: at(40),
      }),
      kind: "managed-worktree",
    });

    expect(screen.queryByTestId("startup-trail")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("cancels a live startup and applies the server's record", async () => {
    startupTransport.cancelThreadStartup.mockResolvedValue(startup({ state: "cancelled", cancellation: "requested", revision: 2 }));
    renderTrail({ startupId, kind: "managed-worktree" });

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(startupTransport.cancelThreadStartup).toHaveBeenCalledWith(startupId);
    await waitFor(() => expect(useThreadStartupStore.getState().recordsByStartupId[startupId]?.state).toBe("cancelled"));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows a cancelled step without a cancel control", () => {
    renderTrail({
      startup: startup({ state: "cancelled", steps: [{ phase: "thread", state: "completed" }, { phase: "setup", state: "cancelled", startedAt: at(2), endedAt: at(11) }] }),
      startupId,
      kind: "managed-worktree",
    });
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("Cancelled9s");
    expect(screen.getByTestId("startup-step-setup")).toHaveAttribute("data-tone", "cancelled");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
