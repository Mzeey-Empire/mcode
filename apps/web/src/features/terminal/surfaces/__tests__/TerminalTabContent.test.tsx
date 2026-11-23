import { mockTransport } from "@/__tests__/mocks/transport";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalKill = vi.mocked(mockTransport.terminalKill);
const terminalHasChildren = vi.mocked(mockTransport.terminalHasChildren);
const terminalCreate = vi.mocked(mockTransport.terminalCreate);
const getWorkspaceActionRun = vi.mocked(mockTransport.getWorkspaceActionRun);

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

beforeEach(() => {
  vi.mocked(mockTransport.terminalKill).mockReset();
  vi.mocked(mockTransport.terminalHasChildren).mockReset();
  vi.mocked(mockTransport.terminalCreate).mockReset();
  vi.mocked(mockTransport.terminalPause).mockReset().mockResolvedValue(undefined);
  vi.mocked(mockTransport.terminalDiagnostics).mockReset();
  vi.mocked(mockTransport.openIn).mockReset();
  vi.mocked(mockTransport.listOpenInApps).mockReset().mockResolvedValue([]);
  vi.mocked(mockTransport.getWorkspaceActionRun).mockReset();
  vi.mocked(mockTransport.readWorkspaceEnvironment).mockReset().mockResolvedValue({ document: { version: "0.0.1", actions: [] }, revision: null, status: "absent" });
  vi.mocked(mockTransport.listWorkspaceActionRuns).mockReset().mockResolvedValue([]);
  vi.mocked(mockTransport.restartWorkspaceAction).mockReset();
  vi.mocked(mockTransport.stopWorkspaceAction).mockReset();
});

import { TERMINAL_MAX_PER_SCOPE } from "@mcode/contracts/models/terminal";
import { type WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useDiffStore } from "@/stores/diffStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { TERMINAL_CLEAR } from "../terminalClear";
import { TerminalTabContent } from "../TerminalTabContent";

type ConfirmOnKill = "never" | "withChildProcesses" | "always";

function shell(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return { id, threadId: "thread-1", label: "pwsh", state: "running", kind: "shell", ...overrides } as TerminalInstance;
}

function seed(terminals: readonly TerminalInstance[], activeId: string | null = terminals[0]?.id ?? null): void {
  useTerminalStore.setState({
    terminals: { "thread-1": [...terminals] },
    activeTerminalByScope: { "thread-1": activeId },
    ptyToThread: Object.fromEntries(terminals.map((terminal) => [terminal.id, "thread-1"])),
    terminalSearchByPty: {},
    splitMode: true,
  });
}

function setConfirmOnKill(value: ConfirmOnKill): void {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: { ...settings, terminal: { ...settings.terminal, behavior: { ...settings.terminal.behavior, confirmOnKill: value } } },
  });
}

async function renderTool(): Promise<ReturnType<typeof render>> {
  const view = render(<TerminalTabContent workspaceId="workspace-1" threadId="thread-1" scopeId="thread-1" />);
  await act(async () => {});
  return view;
}

function actionRun(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "web",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "pty-action",
    trigger: "manual",
    port: null,
    actionName: "web",
    status: "running",
    snapshot: { platform: "linux", script: "bun run dev", checkoutPath: "/repo", terminal: null, environmentNames: [] },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

/** Seeds the run in the store and on the fake server, so the hydration the tool starts on mount keeps it. */
function seedAction(run: WorkspaceEnvironmentActionRun, state: TerminalInstance["state"] = "running"): void {
  useProjectActionStore.getState().applyRun(run);
  vi.mocked(mockTransport.listWorkspaceActionRuns).mockResolvedValue([run]);
  getWorkspaceActionRun.mockResolvedValue(run);
  seed([shell("pty-action", { kind: "action", actionId: "web", label: "web", state })]);
}

const closeTab = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Close ${name} (ends the shell)` }));

describe("Terminal tool header", () => {
  const closeRightPanelTab = vi.spyOn(useDiffStore.getState(), "closeRightPanelTab");

  beforeEach(() => {
    vi.clearAllMocks();
    terminalKill.mockResolvedValue(undefined);
    terminalHasChildren.mockResolvedValue({ hasChildren: false });
    terminalCreate.mockResolvedValue({ ptyId: "new", shell: "pwsh" });
    getWorkspaceActionRun.mockResolvedValue(null);
    useProjectActionStore.setState({ runsByThread: {} });
    useToastStore.setState({ toasts: [] });
    setConfirmOnKill("withChildProcesses");
    seed([shell("pty-1")]);
  });

  afterEach(() => {
    cleanup();
    useToastStore.setState({ toasts: [] });
  });

  describe("closing a terminal", () => {
    it("closes an idle shell without asking and closes the tool with its last record", async () => {
      await renderTool();

      closeTab("pwsh");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-1"));
      await waitFor(() => expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(closeRightPanelTab).toHaveBeenCalledWith("workspace-1", "thread-1", "terminal");
    });

    it("keeps the tool open while other records remain", async () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })]);
      await renderTool();

      closeTab("pwsh");

      await waitFor(() => expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1));
      expect(closeRightPanelTab).not.toHaveBeenCalled();
    });

    it("asks before stopping a shell that has child processes, and Cancel keeps it running", async () => {
      terminalHasChildren.mockResolvedValue({ hasChildren: true });
      await renderTool();

      closeTab("pwsh");
      expect(await screen.findByText("Stop pwsh?")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument());
      expect(terminalKill).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
    });

    it("stops the shell once when the user confirms", async () => {
      terminalHasChildren.mockResolvedValue({ hasChildren: true });
      await renderTool();

      closeTab("pwsh");
      fireEvent.click(await screen.findByRole("button", { name: "Stop and close" }));

      await waitFor(() => expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined());
      expect(terminalKill).toHaveBeenCalledOnce();
    });

    it("asks when the child-process check fails, because losing a process costs more than a click", async () => {
      terminalHasChildren.mockRejectedValue(new Error("inspection unavailable"));
      await renderTool();

      closeTab("pwsh");

      expect(await screen.findByText("Stop pwsh?")).toBeInTheDocument();
      expect(terminalKill).not.toHaveBeenCalled();
    });

    it("keeps the tab and says so when the kill fails", async () => {
      terminalKill.mockRejectedValue(new Error("pty gone"));
      await renderTool();

      closeTab("pwsh");

      await waitFor(() =>
        expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "failed", title: "Couldn't close pwsh. Try again." }),
      );
      expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
      expect(closeRightPanelTab).not.toHaveBeenCalled();
    });

    it("never asks when confirmOnKill is never, even with child processes", async () => {
      setConfirmOnKill("never");
      terminalHasChildren.mockResolvedValue({ hasChildren: true });
      await renderTool();

      closeTab("pwsh");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledOnce());
      expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument();
    });

    it("always asks about a live shell when confirmOnKill is always, without probing for children", async () => {
      setConfirmOnKill("always");
      await renderTool();

      closeTab("pwsh");

      expect(await screen.findByText("Stop pwsh?")).toBeInTheDocument();
      expect(terminalHasChildren).not.toHaveBeenCalled();
    });

    it("never asks about a shell that already exited, even when confirmOnKill is always", async () => {
      setConfirmOnKill("always");
      seed([shell("pty-1", { state: "exited" })]);
      await renderTool();

      closeTab("pwsh");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledOnce());
      expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument();
    });

    it("names the confirmation after the tab it came from", async () => {
      terminalHasChildren.mockResolvedValue({ hasChildren: true });
      await renderTool();

      closeTab("pwsh");

      expect(await screen.findByRole("dialog", { name: "Stop pwsh?" })).toBeInTheDocument();
    });

    it("keeps the newest question and its target when an older probe answers last", async () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })]);
      const answers = new Map<string, (value: { hasChildren: boolean }) => void>();
      terminalHasChildren.mockImplementation(
        (ptyId: string) => new Promise((resolve) => answers.set(ptyId, resolve)),
      );
      await renderTool();

      closeTab("pwsh");
      closeTab("bash");
      await waitFor(() => expect(answers.size).toBe(2));
      answers.get("pty-2")?.({ hasChildren: true });
      expect(await screen.findByText("Stop bash?")).toBeInTheDocument();
      answers.get("pty-1")?.({ hasChildren: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.click(screen.getByRole("button", { name: "Stop and close" }));

      expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument();
      await waitFor(() => expect(terminalKill).toHaveBeenCalledOnce());
      expect(terminalKill).toHaveBeenCalledWith("pty-2");
    });

    it("closes without asking when the shell exits while its children are being checked", async () => {
      let answer: (value: { hasChildren: boolean }) => void = () => {};
      terminalHasChildren.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      await renderTool();

      closeTab("pwsh");
      await waitFor(() => expect(terminalHasChildren).toHaveBeenCalled());
      act(() => useTerminalStore.getState().recordTerminalExit("pty-1", { code: 0, signal: null, reason: "natural" }));
      answer({ hasChildren: true });

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-1"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("drops the question when its terminal goes away underneath it", async () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })]);
      terminalHasChildren.mockResolvedValue({ hasChildren: true });
      await renderTool();

      closeTab("pwsh");
      expect(await screen.findByText("Stop pwsh?")).toBeInTheDocument();
      act(() => useTerminalStore.getState().removeTerminal("pty-1"));

      await waitFor(() => expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument());
      expect(terminalKill).not.toHaveBeenCalled();
    });
  });

  describe("row 1", () => {
    it("numbers shells that share a label and names action records after their action", async () => {
      seed([
        shell("pty-1"),
        shell("pty-2"),
        shell("pty-3", { kind: "action", actionId: "unknown-action", label: "action" }),
      ]);
      await renderTool();

      expect(screen.getByRole("button", { name: "Close 1 · pwsh (ends the shell)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Close 2 · pwsh (ends the shell)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Close Project Action (ends the shell)" })).toBeInTheDocument();
    });

    it("selecting a tab makes it the scope's active terminal", async () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })], "pty-1");
      await renderTool();

      fireEvent.click(screen.getByRole("tab", { name: "bash" }));

      expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("pty-2");
    });

    it("disables + at the server's record cap and explains why", async () => {
      seed(Array.from({ length: TERMINAL_MAX_PER_SCOPE }, (_, index) => shell(`pty-${index}`, { label: `sh${index}` })));
      await renderTool();

      await waitFor(() => expect(screen.getByTestId("panel-tab-add")).not.toHaveAttribute("aria-haspopup"));
      const add = screen.getByTestId("panel-tab-add");
      expect(add).toHaveAttribute("aria-disabled", "true");
      expect(add).toHaveAccessibleDescription(`${TERMINAL_MAX_PER_SCOPE} terminals are open. Close one to open another.`);
    });
  });

  describe("action tabs", () => {
    it.each([
      ["running", { status: "running" as const }, "running", "Running"],
      ["failed", { status: "failed" as const, exitCode: 1 }, "failed", "Failed"],
    ])("badges a %s run", async (_name, overrides, badge, label) => {
      seedAction(actionRun(overrides));
      await renderTool();

      expect(screen.getByTestId("action-tab-badge")).toHaveAttribute("data-badge", badge);
      expect(screen.getByRole("tab", { name: `web, ${label}` })).toHaveAttribute("aria-selected");
    });

    it("shows the needs-you ring for a run awaiting approval", async () => {
      seedAction(actionRun({ status: "awaiting-approval", startedAt: null }), "pending");
      await renderTool();

      expect(screen.getByTestId("action-tab-badge")).toHaveAttribute("data-badge", "pending");
      expect(screen.getByRole("tab", { name: "web, Approval required" })).toHaveAttribute("aria-selected");
    });

    it("closes a pending action without asking, even when confirmOnKill is always, since nothing is running", async () => {
      setConfirmOnKill("always");
      seedAction(actionRun({ status: "awaiting-approval", startedAt: null }), "pending");
      await renderTool();

      closeTab("web");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-action"));
      expect(screen.queryByText("Stop web?")).not.toBeInTheDocument();
    });

    it("shows no badge once the run completed", async () => {
      seedAction(actionRun({ status: "completed", exitCode: 0 }));
      await renderTool();

      expect(screen.queryByTestId("action-tab-badge")).not.toBeInTheDocument();
    });

    it("asks to stop a running action without probing for children, and names its command", async () => {
      seedAction(actionRun());
      await renderTool();

      closeTab("web");

      expect(await screen.findByText("Stop web?")).toBeInTheDocument();
      expect(screen.getByText("bun run dev is still running. Closing the tab stops it.")).toBeInTheDocument();
      expect(terminalHasChildren).not.toHaveBeenCalled();
      expect(terminalKill).not.toHaveBeenCalled();
    });

    it("kills the terminal when the user confirms Stop and close", async () => {
      seedAction(actionRun());
      await renderTool();

      closeTab("web");
      fireEvent.click(await screen.findByRole("button", { name: "Stop and close" }));

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-action"));
    });

    it("keeps a running action when the user cancels", async () => {
      seedAction(actionRun());
      await renderTool();

      closeTab("web");
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByText("Stop web?")).not.toBeInTheDocument());
      expect(terminalKill).not.toHaveBeenCalled();
    });

    it("does not ask about a running action when confirmOnKill is never", async () => {
      setConfirmOnKill("never");
      seedAction(actionRun());
      await renderTool();

      closeTab("web");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-action"));
      expect(screen.queryByText("Stop web?")).not.toBeInTheDocument();
    });

    it("treats an action whose command ended like any shell and skips the question without children", async () => {
      seedAction(actionRun({ status: "completed", exitCode: 0 }));
      await renderTool();

      closeTab("web");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-action"));
      expect(terminalHasChildren).toHaveBeenCalledWith("pty-action");
    });
  });

  describe("row 2", () => {
    it("shows the active shell's folder name first and keeps the full path on the copy button", async () => {
      seed([shell("pty-1", { cwd: "/work/repo" })]);
      await renderTool();

      const pill = screen.getByTestId("working-folder-pill");
      expect(pill).toHaveTextContent(/^repo\/work\/$/);
      expect(screen.getByRole("button", { name: "Copy /work/repo" })).toBeInTheDocument();
    });

    it("follows the active tab", async () => {
      seed([shell("pty-1", { cwd: "/work/one" }), shell("pty-2", { cwd: "/work/two", label: "bash" })], "pty-1");
      await renderTool();
      expect(screen.getByRole("button", { name: "Copy /work/one" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: "bash" }));

      expect(screen.getByRole("button", { name: "Copy /work/two" })).toBeInTheDocument();
    });

    it("offers action controls, not shell controls, for an action record", async () => {
      seedAction(actionRun());
      await renderTool();

      expect(screen.getByTestId("action-command-pill")).toHaveTextContent("bun run dev");
      expect(screen.queryByTestId("working-folder-pill")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Clear terminal" })).not.toBeInTheDocument();
    });

    it("offers only the command pill and More while the run awaits approval", async () => {
      seedAction(actionRun({ status: "awaiting-approval", startedAt: null }), "pending");
      await renderTool();

      expect(screen.getByTestId("action-command-pill")).toHaveTextContent("bun run dev");
      expect(screen.getByRole("button", { name: "More terminal actions" })).toBeInTheDocument();
      for (const name of ["Restart", "Stop", "Run again"]) {
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      }
    });

    it("Clear asks only the active terminal to clear its view", async () => {
      const cleared: string[] = [];
      const listener = (event: Event) => cleared.push((event as CustomEvent<string>).detail);
      window.addEventListener(TERMINAL_CLEAR, listener);
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })], "pty-2");
      await renderTool();

      fireEvent.click(screen.getByRole("button", { name: "Clear terminal" }));
      window.removeEventListener(TERMINAL_CLEAR, listener);

      expect(cleared).toEqual(["pty-2"]);
    });

    it("Search opens the shelf for the active terminal", async () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })], "pty-2");
      await renderTool();

      fireEvent.click(screen.getByRole("button", { name: "Search terminal" }));

      expect(useTerminalStore.getState().terminalSearchByPty["pty-2"]?.open).toBe(true);
      expect(useTerminalStore.getState().terminalSearchByPty["pty-1"]).toBeUndefined();
    });
  });
});
