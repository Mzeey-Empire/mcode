import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalKill = vi.fn();
const terminalHasChildren = vi.fn();
const terminalCreate = vi.fn();
const getWorkspaceActionRun = vi.fn();

vi.mock("@/transport", () => ({
  getTransport: () => ({
    terminalKill,
    terminalHasChildren,
    terminalCreate,
    terminalPause: vi.fn().mockResolvedValue(undefined),
    terminalDiagnostics: vi.fn(),
    openIn: vi.fn(),
    listOpenInApps: vi.fn().mockResolvedValue([]),
    getWorkspaceActionRun,
    restartWorkspaceAction: vi.fn(),
    stopWorkspaceAction: vi.fn(),
  }),
}));

import { TERMINAL_MAX_PER_SCOPE, type WorkspaceEnvironmentActionRun } from "@mcode/contracts";
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

function renderTool() {
  return render(<TerminalTabContent workspaceId="workspace-1" threadId="thread-1" scopeId="thread-1" />);
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

function seedAction(run: WorkspaceEnvironmentActionRun): void {
  useProjectActionStore.getState().applyRun(run);
  seed([shell("pty-action", { kind: "action", actionId: "web", label: "web" })]);
}

const closeTab = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Close ${name}` }));

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
    useToastStore.setState({ toasts: [] });
  });

  describe("closing a terminal", () => {
    it("closes an idle shell without asking and closes the tool with its last record", async () => {
      renderTool();

      closeTab("pwsh");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-1"));
      await waitFor(() => expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(closeRightPanelTab).toHaveBeenCalledWith("workspace-1", "thread-1", "terminal");
    });

    it("keeps the tool open while other records remain", async () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })]);
      renderTool();

      closeTab("pwsh");

      await waitFor(() => expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1));
      expect(closeRightPanelTab).not.toHaveBeenCalled();
    });

    it("asks before stopping a shell that has child processes, and Cancel keeps it running", async () => {
      terminalHasChildren.mockResolvedValue({ hasChildren: true });
      renderTool();

      closeTab("pwsh");
      expect(await screen.findByText("Stop pwsh?")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument());
      expect(terminalKill).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
    });

    it("stops the shell once when the user confirms", async () => {
      terminalHasChildren.mockResolvedValue({ hasChildren: true });
      renderTool();

      closeTab("pwsh");
      fireEvent.click(await screen.findByRole("button", { name: "Stop and close" }));

      await waitFor(() => expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined());
      expect(terminalKill).toHaveBeenCalledOnce();
    });

    it("asks when the child-process check fails, because losing a process costs more than a click", async () => {
      terminalHasChildren.mockRejectedValue(new Error("inspection unavailable"));
      renderTool();

      closeTab("pwsh");

      expect(await screen.findByText("Stop pwsh?")).toBeInTheDocument();
      expect(terminalKill).not.toHaveBeenCalled();
    });

    it("keeps the tab and says so when the kill fails", async () => {
      terminalKill.mockRejectedValue(new Error("pty gone"));
      renderTool();

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
      renderTool();

      closeTab("pwsh");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledOnce());
      expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument();
    });

    it("always asks about a live shell when confirmOnKill is always, without probing for children", async () => {
      setConfirmOnKill("always");
      renderTool();

      closeTab("pwsh");

      expect(await screen.findByText("Stop pwsh?")).toBeInTheDocument();
      expect(terminalHasChildren).not.toHaveBeenCalled();
    });

    it("never asks about a shell that already exited, even when confirmOnKill is always", async () => {
      setConfirmOnKill("always");
      seed([shell("pty-1", { state: "exited" })]);
      renderTool();

      closeTab("pwsh");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledOnce());
      expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument();
    });

    it("names the confirmation after the tab it came from", async () => {
      terminalHasChildren.mockResolvedValue({ hasChildren: true });
      renderTool();

      closeTab("pwsh");

      expect(await screen.findByRole("dialog", { name: "Stop pwsh?" })).toBeInTheDocument();
    });

    it("keeps the newest question and its target when an older probe answers last", async () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })]);
      const answers = new Map<string, (value: { hasChildren: boolean }) => void>();
      terminalHasChildren.mockImplementation(
        (ptyId: string) => new Promise((resolve) => answers.set(ptyId, resolve)),
      );
      renderTool();

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
      renderTool();

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
      renderTool();

      closeTab("pwsh");
      expect(await screen.findByText("Stop pwsh?")).toBeInTheDocument();
      act(() => useTerminalStore.getState().removeTerminal("pty-1"));

      await waitFor(() => expect(screen.queryByText("Stop pwsh?")).not.toBeInTheDocument());
      expect(terminalKill).not.toHaveBeenCalled();
    });
  });

  describe("row 1", () => {
    it("numbers shells that share a label and names action records after their action", () => {
      seed([
        shell("pty-1"),
        shell("pty-2"),
        shell("pty-3", { kind: "action", actionId: "unknown-action", label: "action" }),
      ]);
      renderTool();

      expect(screen.getByRole("button", { name: "Close pwsh (1)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Close pwsh (2)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Close Project Action" })).toBeInTheDocument();
    });

    it("selecting a tab makes it the scope's active terminal", () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })], "pty-1");
      renderTool();

      fireEvent.click(screen.getByRole("button", { name: "bash" }));

      expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("pty-2");
    });

    it("disables + at the server's record cap and explains why", () => {
      seed(Array.from({ length: TERMINAL_MAX_PER_SCOPE }, (_, index) => shell(`pty-${index}`, { label: `sh${index}` })));
      renderTool();

      const add = screen.getByTestId("panel-tab-add");
      expect(add).toHaveAttribute("aria-disabled", "true");
      expect(add).toHaveAccessibleDescription(`${TERMINAL_MAX_PER_SCOPE} terminals are open. Close one to open another.`);
    });
  });

  describe("action tabs", () => {
    it.each([
      ["running", { status: "running" as const }, "running", "Running"],
      ["failed", { status: "failed" as const, exitCode: 1 }, "failed", "Failed"],
    ])("badges a %s run", (_name, overrides, badge, label) => {
      seedAction(actionRun(overrides));
      renderTool();

      expect(screen.getByTestId("action-tab-badge")).toHaveAttribute("data-badge", badge);
      expect(screen.getByRole("button", { name: `web, ${label}` })).toHaveAttribute("aria-pressed");
    });

    it("shows no badge once the run completed", () => {
      seedAction(actionRun({ status: "completed", exitCode: 0 }));
      renderTool();

      expect(screen.queryByTestId("action-tab-badge")).not.toBeInTheDocument();
    });

    it("asks to stop a running action without probing for children, and names its command", async () => {
      seedAction(actionRun());
      renderTool();

      closeTab("web");

      expect(await screen.findByText("Stop web?")).toBeInTheDocument();
      expect(screen.getByText("bun run dev is still running. Closing the tab stops it.")).toBeInTheDocument();
      expect(terminalHasChildren).not.toHaveBeenCalled();
      expect(terminalKill).not.toHaveBeenCalled();
    });

    it("kills the terminal when the user confirms Stop and close", async () => {
      seedAction(actionRun());
      renderTool();

      closeTab("web");
      fireEvent.click(await screen.findByRole("button", { name: "Stop and close" }));

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-action"));
    });

    it("keeps a running action when the user cancels", async () => {
      seedAction(actionRun());
      renderTool();

      closeTab("web");
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByText("Stop web?")).not.toBeInTheDocument());
      expect(terminalKill).not.toHaveBeenCalled();
    });

    it("does not ask about a running action when confirmOnKill is never", async () => {
      setConfirmOnKill("never");
      seedAction(actionRun());
      renderTool();

      closeTab("web");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-action"));
      expect(screen.queryByText("Stop web?")).not.toBeInTheDocument();
    });

    it("treats an action whose command ended like any shell and skips the question without children", async () => {
      seedAction(actionRun({ status: "completed", exitCode: 0 }));
      renderTool();

      closeTab("web");

      await waitFor(() => expect(terminalKill).toHaveBeenCalledWith("pty-action"));
      expect(terminalHasChildren).toHaveBeenCalledWith("pty-action");
    });
  });

  describe("row 2", () => {
    it("shows the active shell's working folder with the last segment emphasised", () => {
      seed([shell("pty-1", { cwd: "/work/repo" })]);
      renderTool();

      const pill = screen.getByTestId("working-folder-pill");
      expect(pill).toHaveTextContent("/work/repo");
      expect(screen.getByText("repo")).toBeInTheDocument();
    });

    it("follows the active tab", () => {
      seed([shell("pty-1", { cwd: "/work/one" }), shell("pty-2", { cwd: "/work/two", label: "bash" })], "pty-1");
      renderTool();
      expect(screen.getByTestId("working-folder-pill")).toHaveTextContent("/work/one");

      fireEvent.click(screen.getByRole("button", { name: "bash" }));

      expect(screen.getByTestId("working-folder-pill")).toHaveTextContent("/work/two");
    });

    it("offers action controls, not shell controls, for an action record", () => {
      seedAction(actionRun());
      renderTool();

      expect(screen.getByTestId("action-command-pill")).toHaveTextContent("bun run dev");
      expect(screen.queryByTestId("working-folder-pill")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Clear terminal" })).not.toBeInTheDocument();
    });

    it("Clear asks only the active terminal to clear its view", () => {
      const cleared: string[] = [];
      const listener = (event: Event) => cleared.push((event as CustomEvent<string>).detail);
      window.addEventListener(TERMINAL_CLEAR, listener);
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })], "pty-2");
      renderTool();

      fireEvent.click(screen.getByRole("button", { name: "Clear terminal" }));
      window.removeEventListener(TERMINAL_CLEAR, listener);

      expect(cleared).toEqual(["pty-2"]);
    });

    it("Search opens the shelf for the active terminal", () => {
      seed([shell("pty-1"), shell("pty-2", { label: "bash" })], "pty-2");
      renderTool();

      fireEvent.click(screen.getByRole("button", { name: "Search terminal" }));

      expect(useTerminalStore.getState().terminalSearchByPty["pty-2"]?.open).toBe(true);
      expect(useTerminalStore.getState().terminalSearchByPty["pty-1"]).toBeUndefined();
    });
  });
});
