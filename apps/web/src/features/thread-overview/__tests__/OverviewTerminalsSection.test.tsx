import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { mockTransport, createMockThread } from "@/__tests__/mocks/transport";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { useDiffStore } from "@/stores/diffStore";
import { OverviewTerminalsSection } from "../entries/terminals";

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => mockTransport,
}));

const thread = createMockThread({ id: "thread-1", workspace_id: "ws-1" });

function shell(id: string, createdAt: string): TerminalInstance {
  return { id, threadId: thread.id, label: "pwsh", kind: "shell", state: "running", createdAt };
}

function actionTerminal(id: string, actionId: string, createdAt: string): TerminalInstance {
  return { id, threadId: thread.id, label: "Dev", kind: "action", actionId, state: "running", createdAt };
}

function run(
  actionId: string,
  status: WorkspaceEnvironmentActionRun["status"],
  port: number | null = null,
): WorkspaceEnvironmentActionRun {
  const runId = `run-${actionId}`;
  return {
    threadId: thread.id,
    workspaceId: "ws-1",
    actionId,
    runId,
    revision: 1,
    terminalSessionId: `term-${actionId}`,
    trigger: "manual",
    port: port === null
      ? null
      : { runId, port, host: "localhost", url: `http://localhost:${port}`, reachable: true, detectedAt: "2026-10-10T10:00:00.000Z" },
    actionName: "Dev",
    status,
    snapshot: {
      platform: "windows",
      script: "bun run dev",
      checkoutPath: "C:\\repo",
      terminal: { executable: "powershell.exe", arguments: [] },
      environmentNames: [],
    },
    createdAt: "2026-10-10T10:00:00.000Z",
    startedAt: "2026-10-10T10:00:00.000Z",
    finishedAt: null,
    exitCode: null,
  };
}

function seed(
  terminals: readonly TerminalInstance[],
  runs: Record<string, WorkspaceEnvironmentActionRun> = {},
): void {
  useTerminalStore.setState({
    terminals: { [thread.id]: terminals },
    ptyToThread: Object.fromEntries(terminals.map((terminal) => [terminal.id, thread.id])),
    activeTerminalByScope: {},
  });
  useProjectActionStore.setState({ runsByThread: { [thread.id]: runs } });
}

function renderSection() {
  return render(<OverviewTerminalsSection subject={{ kind: "thread", thread }} />);
}

describe("OverviewTerminalsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed([]);
  });

  it("renders nothing when no terminal is doing anything", () => {
    seed([{ ...shell("a", "2026-10-10T10:00:00.000Z"), state: "exited" }]);
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it("lists a running action with its port and a shell without one", () => {
    seed(
      [shell("sh", "2026-10-10T10:00:00.000Z"), actionTerminal("term-dev", "dev", "2026-10-10T10:01:00.000Z")],
      { dev: run("dev", "running", 5173) },
    );
    renderSection();

    const rows = screen.getAllByTestId("thread-overview-terminal");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Dev:5173");
    expect(rows[1]).toHaveTextContent("pwshShell");
  });

  it("shows a running action that announced no port without calling it a shell", () => {
    seed([actionTerminal("term-dev", "dev", "2026-10-10T10:00:00.000Z")], { dev: run("dev", "running") });
    renderSection();

    expect(screen.getByTestId("thread-overview-terminal")).toHaveTextContent(/^Dev$/);
  });

  it("omits a finished action, whose record stays behind as an idle shell", () => {
    seed([actionTerminal("term-dev", "dev", "2026-10-10T10:00:00.000Z")], { dev: run("dev", "completed") });
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it("folds rows past three behind a toggle", async () => {
    const user = userEvent.setup();
    seed([1, 2, 3, 4, 5].map((n) => shell(`sh-${n}`, `2026-10-10T10:0${n}:00.000Z`)));
    renderSection();

    expect(screen.getAllByTestId("thread-overview-terminal")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "2 more" }));
    expect(screen.getAllByTestId("thread-overview-terminal")).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getAllByTestId("thread-overview-terminal")).toHaveLength(3);
  });

  it("stops the terminal: the row leaves once it exits and the tab stays", async () => {
    const user = userEvent.setup();
    seed([shell("sh", "2026-10-10T10:00:00.000Z")]);
    renderSection();

    await user.click(screen.getByRole("button", { name: "Stop pwsh" }));

    expect(mockTransport.terminalKill).toHaveBeenCalledWith("sh");

    act(() => useTerminalStore.getState().recordTerminalExit("sh", { code: null, signal: null, reason: "natural" }));

    expect(screen.queryByTestId("thread-overview-terminal")).not.toBeInTheDocument();
    expect(useTerminalStore.getState().terminals[thread.id]).toHaveLength(1);
  });

  it("opens the Terminal tab on the clicked row", async () => {
    const user = userEvent.setup();
    seed([shell("a", "2026-10-10T10:00:00.000Z"), shell("b", "2026-10-10T10:01:00.000Z")]);
    renderSection();

    const row = screen.getAllByTestId("thread-overview-terminal")[1]!;
    await user.click(within(row).getByRole("button", { name: /^pwsh/ }));

    expect(useTerminalStore.getState().activeTerminalByScope[thread.id]).toBe("a");
    expect(useDiffStore.getState().getRightPanel("ws-1", thread.id)).toMatchObject({
      visible: true,
      activeTabId: "singleton:terminal",
    });
  });
});
