import type { ThreadStartup } from "@mcode/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const startupTransport = {
  cancelThreadStartup: vi.fn(),
  getAutomaticSetup: vi.fn(),
};

vi.mock("@/transport", () => ({
  getTransport: () => startupTransport,
}));

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
      { phase: "setup", state: "running", startedAt: at(2) },
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

function setupScript(script: string | null) {
  startupTransport.getAutomaticSetup.mockResolvedValue({
    gate: "not-required",
    attempt: script === null ? null : { state: "running", snapshot: { script } },
    queuedTurns: [],
  });
}

function renderTrail(props: Parameters<typeof StartupStepsTrail>[0]) {
  return render(<TooltipProvider><StartupStepsTrail {...props} /></TooltipProvider>);
}

function rowLabels() {
  return screen.getAllByTestId(/^startup-step-/).map((row) => [row.dataset.testid, row.dataset.tone, row.textContent]);
}

describe("StartupStepsTrail", () => {
  beforeEach(() => setupScript(null));

  afterEach(() => {
    vi.useRealTimers();
    startupTransport.cancelThreadStartup.mockReset();
    startupTransport.getAutomaticSetup.mockReset();
    useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {} });
  });

  it("draws pending placeholder rows before the record arrives", () => {
    renderTrail({ kind: "managed-worktree" });
    expect(rowLabels()).toEqual([
      ["startup-step-worktree", "pending", "Create worktree"],
      ["startup-step-setup", "pending", "Run setup"],
      ["startup-step-agent", "pending", "Start thread"],
    ]);
    expect(screen.queryByTestId("startup-step-thread")).toBeNull();
    expect(screen.getByTestId("startup-step-agent")).toHaveClass("opacity-50");
  });

  it("ticks the live row and labels it with the setup command", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(at(5)) });
    setupScript("bun install\nbun run build");
    renderTrail({ startup: startup(), kind: "managed-worktree" });

    await waitFor(() => expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("Running setupbun install0:03"));
    expect(screen.getByTestId("startup-step-worktree")).toHaveTextContent("Created worktreemcode-3f2a0:02");
    expect(startupTransport.getAutomaticSetup).toHaveBeenCalledTimes(1);
    expect(startupTransport.getAutomaticSetup).toHaveBeenCalledWith("thread-1");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("0:05");
    expect(startupTransport.getAutomaticSetup).toHaveBeenCalledTimes(1);
  });

  it("expands the live setup row into the script and output tail", async () => {
    setupScript("bun install");
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
    setupScript("bun install");
    renderTrail({
      startup: startup({
        state: "failed",
        steps: [
          { phase: "thread", state: "completed" },
          { phase: "worktree", state: "completed", startedAt: at(0), endedAt: at(2), detail: { phase: "worktree", mode: "created", folderName: "mcode-3f2a", path: "/w" } },
          { phase: "setup", state: "failed", startedAt: at(2), endedAt: at(16), detail: { phase: "setup", exitCode: 1 } },
          { phase: "agent", state: "pending" },
        ],
        error: { code: "SETUP_FAILED", message: "Setup failed", retryable: true, detail: "error: lockfile had changes" },
      }),
      kind: "managed-worktree",
      actions: <button type="button">Retry setup</button>,
    });

    expect(screen.getByTestId("startup-step-setup")).toHaveAttribute("data-tone", "failed");
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("Setup failedexit 1 · 0:14");
    expect(screen.getByTestId("startup-detail")).toHaveTextContent("error: lockfile had changes");
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("asks for approval on a blocked step", () => {
    renderTrail({
      startup: startup({ state: "blocked", steps: [{ phase: "thread", state: "completed" }, { phase: "setup", state: "blocked", startedAt: at(2) }] }),
      kind: "managed-worktree",
    });
    expect(screen.getByTestId("startup-step-setup")).toHaveAttribute("data-tone", "attention");
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("Setup needs approval");
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

  it("collapses a completed startup to one row that expands back to its steps", async () => {
    setupScript("bun install");
    renderTrail({
      startup: startup({
        state: "completed",
        phase: "agent",
        steps: [
          { phase: "thread", state: "completed" },
          { phase: "worktree", state: "completed", startedAt: at(0), endedAt: at(2), detail: { phase: "worktree", mode: "created", folderName: "mcode-3f2a", path: "/w" } },
          { phase: "setup", state: "completed", startedAt: at(2), endedAt: at(14) },
          { phase: "agent", state: "completed", startedAt: at(14), endedAt: at(22) },
        ],
        updatedAt: at(40),
      }),
      kind: "managed-worktree",
    });

    const started = screen.getByTestId("startup-started-row");
    await waitFor(() => expect(started).toHaveTextContent("Started in0:22· mcode-3f2a · bun install"));
    expect(screen.queryByTestId("startup-step-setup")).toBeNull();

    await userEvent.click(started);
    expect(rowLabels().map(([, , text]) => text)).toEqual([
      "Created worktreemcode-3f2a0:02",
      "Ran setupbun install0:12",
      "Started thread0:08",
    ]);
    await userEvent.click(screen.getByTestId("startup-started-row"));
    expect(screen.queryByTestId("startup-step-setup")).toBeNull();
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
    expect(screen.getByTestId("startup-step-setup")).toHaveTextContent("Cancelled0:09");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
