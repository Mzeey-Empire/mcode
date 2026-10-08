import { describe, it, expect, vi, beforeEach } from "vitest";

const terminalPause = vi.fn().mockResolvedValue(undefined);
const terminalResume = vi.fn().mockResolvedValue(undefined);

vi.mock("@/transport", () => ({
  getTransport: () => ({ terminalPause, terminalResume }),
}));

// Import AFTER vi.mock — vitest hoists vi.mock to the top automatically,
// so the store sees the mocked transport when the module initializes.
import { useTerminalStore } from "../terminalStore";
import { createRightPanelState, useDiffStore } from "@/stores/diffStore";

describe("terminalStore pause/resume wiring", () => {
  beforeEach(() => {
    terminalPause.mockClear();
    terminalResume.mockClear();
    useTerminalStore.setState({
      hasHydrated: false,
      terminals: {},
      terminalPanelByThread: {},
      ptyToThread: {},
      terminalSearchByPty: {},
      splitMode: false,
    });
  });

  it("hydrates each scope in creation order with shell names and exit metadata", () => {
    useTerminalStore.getState().reconcileActiveSessions([
      { ptyId: "second", threadId: "thread", shell: "bash", state: "running", kind: "action", cwd: "/repo", createdAt: "2026-10-08T12:01:00.000Z" },
      { ptyId: "other", threadId: "workspace", shell: "zsh", state: "pending", createdAt: "2026-10-08T12:02:00.000Z" },
      { ptyId: "first", threadId: "thread", shell: "pwsh", state: "exited", exitCode: 7, kind: "shell", cwd: "/repo", createdAt: "2026-10-08T12:00:00.000Z" },
    ]);
    const state = useTerminalStore.getState();
    expect(state.terminals.thread.map(({ id, label, state, exitCode, cwd, createdAt, kind }) =>
      ({ id, label, state, exitCode, cwd, createdAt, kind }))).toEqual([
      { id: "first", label: "pwsh", state: "exited", exitCode: 7, kind: "shell", cwd: "/repo", createdAt: "2026-10-08T12:00:00.000Z" },
      { id: "second", label: "bash", state: "running", exitCode: undefined, kind: "action", cwd: "/repo", createdAt: "2026-10-08T12:01:00.000Z" },
    ]);
    expect(state.terminals.workspace.map(({ id, label, state }) => [id, label, state])).toEqual([["other", "zsh", "pending"]]);
    expect(state.terminalPanelByThread.thread.activeTerminalId).toBe("first");
    expect(state.hasHydrated).toBe(true);
  });

  it("counts pending, running, and exited records at the cap and replaces Retry in place", () => {
    const store = useTerminalStore.getState();
    store.reconcileActiveSessions([
      { ptyId: "1", threadId: "thread", shell: "pwsh", state: "pending" },
      ...["2", "3", "4", "5", "6", "7", "8"].map((ptyId) => ({ ptyId, threadId: "thread", shell: "pwsh" })),
    ]);
    store.recordTerminalExit("2", { code: 3, signal: null, reason: "natural" });
    store.addTerminal("thread", "9", "pwsh");
    expect(useTerminalStore.getState().terminals.thread.map((terminal) => terminal.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(useTerminalStore.getState().terminals.thread[1].exitCode).toBe(3);
    store.replaceTerminal("2", { ptyId: "replacement", threadId: "thread", shell: "bash", state: "running" });
    expect(useTerminalStore.getState().terminals.thread.map((terminal) => terminal.id)).toEqual(["1", "replacement", "3", "4", "5", "6", "7", "8"]);
    expect(useTerminalStore.getState().ptyToThread["2"]).toBeUndefined();
    expect(useTerminalStore.getState().terminalPanelByThread.thread.activeTerminalId).toBe("replacement");
    store.removeTerminal("1");
    store.addTerminal("thread", "9", "pwsh");
    expect(useTerminalStore.getState().terminals.thread.map((terminal) => terminal.id)).toEqual(["replacement", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("rebuilds panel tabs without opening a hidden panel or losing other tools", () => {
    useDiffStore.setState({ rightPanelByThread: {
      thread: createRightPanelState({ visible: false, width: 400, activeTabId: "terminal:old", tabInstances: [
        { id: "singleton:changes", type: "changes" }, { id: "terminal:old", type: "terminal" },
      ] }),
    } });
    const panels = useDiffStore.getState();
    panels.reconcileRightPanelTerminals("workspace", "thread", ["first", "second"], "first");
    expect(useDiffStore.getState().rightPanelByThread.thread).toMatchObject({
      visible: false, width: 400, activeTabId: "terminal:first", tabInstances: [
        { id: "singleton:changes", type: "changes" }, { id: "terminal:first", type: "terminal" }, { id: "terminal:second", type: "terminal" },
      ],
    });
    panels.reconcileRightPanelTerminals("workspace", "thread", [], null);
    expect(useDiffStore.getState().rightPanelByThread.thread.tabInstances).toEqual([{ id: "singleton:changes", type: "changes" }]);
  });

  it("keeps the exit code when the shell exits before create responds", () => {
    useTerminalStore.getState().addTerminal("thread", "fast-exit", "pwsh", { state: "exited", exitCode: 7 });
    expect(useTerminalStore.getState().terminals.thread[0]).toMatchObject({
      id: "fast-exit", state: "exited", exitCode: 7,
      exit: { code: 7, signal: null, reason: "natural" },
    });
  });

  it("pauses only the selected PTY and leaves resume to the mounted view", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-a");
    store.addTerminal("thread-1", "pty-b");
    // Selecting the new shell pauses the renderer that is about to unmount.
    expect(terminalPause).toHaveBeenCalledWith("pty-a");
    expect(terminalResume).not.toHaveBeenCalled();
    terminalPause.mockClear();

    store.hideTerminalPanel("thread-1");
    expect(terminalPause).toHaveBeenCalledOnce();
    expect(terminalPause).toHaveBeenCalledWith("pty-b");
    expect(terminalResume).not.toHaveBeenCalled();

    store.showTerminalPanel("thread-1");
    expect(terminalResume).not.toHaveBeenCalled();
  });

  it("pauses the prior selection without resuming before reattach", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-a");
    store.addTerminal("thread-1", "pty-b");
    terminalPause.mockClear();

    store.setActiveTerminal("thread-1", "pty-a");

    expect(terminalPause).toHaveBeenCalledWith("pty-b");
    expect(terminalResume).not.toHaveBeenCalled();
  });

  it("no-ops when hiding an already-hidden panel", () => {
    useTerminalStore.getState().hideTerminalPanel("unknown-thread");
    expect(terminalPause).not.toHaveBeenCalled();
  });

  it("toggleTerminalPanel pauses on hide without resuming from the store", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-2", "pty-c");
    // Panel is visible after addTerminal. Toggle → hide → pause.
    store.toggleTerminalPanel("thread-2");
    expect(terminalPause).toHaveBeenCalledOnce();
    // Toggle again → show; TerminalView reattaches before it resumes.
    store.toggleTerminalPanel("thread-2");
    expect(terminalResume).not.toHaveBeenCalled();
  });

  it("reconciles stale client PTYs when the restarted server reports none", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "stale-pty");

    store.reconcileActiveSessions([]);

    expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
    expect(useTerminalStore.getState().ptyToThread["stale-pty"]).toBeUndefined();
  });

  it("restores server-only PTYs and removes client-only PTYs on reconnect", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "client-only");

    store.reconcileActiveSessions([
      { ptyId: "server-pty", threadId: "thread-2" },
    ]);

    const next = useTerminalStore.getState();
    expect(next.terminals["thread-1"]).toBeUndefined();
    expect(next.terminals["thread-2"]?.map((terminal) => terminal.id)).toEqual([
      "server-pty",
    ]);
    expect(next.terminalPanelByThread["thread-2"]?.activeTerminalId).toBe(
      "server-pty",
    );
  });

  it("keeps search state per PTY and removes it with the PTY", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-a");
    store.addTerminal("thread-1", "pty-b");

    store.openTerminalSearch("pty-a");
    store.setTerminalSearchQuery("pty-a", "alpha");
    store.setTerminalSearchOptions("pty-a", {
      caseSensitive: true,
      wholeWord: true,
      regex: true,
    });
    store.setTerminalSearchResult("pty-a", 2, 5);

    store.openTerminalSearch("pty-b");
    store.setTerminalSearchQuery("pty-b", "beta");

    expect(useTerminalStore.getState().terminalSearchByPty).toMatchObject({
      "pty-a": {
        query: "alpha",
        options: { caseSensitive: true, wholeWord: true, regex: true },
        resultIndex: 2,
        resultCount: 5,
      },
      "pty-b": { query: "beta" },
    });

    store.removeTerminal("pty-a");
    expect(useTerminalStore.getState().terminalSearchByPty["pty-a"]).toBeUndefined();
    expect(useTerminalStore.getState().terminalSearchByPty["pty-b"]?.query).toBe("beta");
  });

  it("removes search state for PTYs omitted by reconnect reconciliation", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-stale");
    store.openTerminalSearch("pty-stale");
    store.setTerminalSearchQuery("pty-stale", "stale");

    store.reconcileActiveSessions([]);

    expect(useTerminalStore.getState().terminalSearchByPty["pty-stale"]).toBeUndefined();
  });

  it("retains an exited terminal until the user explicitly closes it", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-exited");

    store.recordTerminalExit("pty-exited", {
      code: 7,
      signal: null,
      reason: "natural",
    });

    expect(useTerminalStore.getState().terminals["thread-1"]).toEqual([
      expect.objectContaining({
        id: "pty-exited",
        state: "exited",
        exit: { code: 7, signal: null, reason: "natural" },
      }),
    ]);
    store.removeTerminal("pty-exited");
    expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
  });
});
