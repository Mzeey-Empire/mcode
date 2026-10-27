import { mockTransport } from "@/__tests__/mocks/transport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserHistory } from "@mcode/contracts/models/browser-preview";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";

const transport = {
  listWorkspaceActionRuns: vi.mocked(mockTransport.listWorkspaceActionRuns),
  startWorkspaceAction: vi.mocked(mockTransport.startWorkspaceAction),
  restartWorkspaceAction: vi.mocked(mockTransport.restartWorkspaceAction),
};

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.listWorkspaceActionRuns).mockReset();
  vi.mocked(mockTransport.startWorkspaceAction).mockReset();
  vi.mocked(mockTransport.restartWorkspaceAction).mockReset();
});

import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTerminalStore } from "@/features/terminal";
import { useToastStore } from "@/stores/toastStore";
import { BrowserNewPage } from "../BrowserNewPage";

const THREAD_ID = "thread-1";
const WORKSPACE_ID = "workspace-1";

function actionRun(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: THREAD_ID,
    workspaceId: WORKSPACE_ID,
    actionId: "web",
    runId: "run-1",
    revision: 1,
    terminalSessionId: "pty-1",
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

function stoppedRun(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return actionRun({
    status: "interrupted",
    port: actionPort({ reachable: false }),
    finishedAt: "2026-08-22T12:05:00.000Z",
    ...overrides,
  });
}

/** The server's list is authoritative, so seeded runs must also come back from it. */
function seedRuns(...runs: WorkspaceEnvironmentActionRun[]): void {
  for (const run of runs) useProjectActionStore.getState().applyRun(run);
  transport.listWorkspaceActionRuns.mockResolvedValue(Object.values(useProjectActionStore.getState().runsByThread[THREAD_ID] ?? {}));
}

function installHistory(history: BrowserHistory) {
  const bridge = {
    list: vi.fn().mockResolvedValue(history),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as { desktopBridge: unknown }).desktopBridge = { preview: { history: bridge } };
  return bridge;
}

function renderPage(onOpen = vi.fn(), threadId = THREAD_ID) {
  render(<BrowserNewPage threadId={threadId} browserWorkspaceId={WORKSPACE_ID} onOpen={onOpen} />);
  return onOpen;
}

function tile(name: string): HTMLElement {
  const match = screen.getAllByTestId("browser-server-tile").find((candidate) => candidate.textContent?.includes(name));
  if (!match) throw new Error(`no tile named ${name}`);
  return match;
}

describe("BrowserNewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.listWorkspaceActionRuns.mockResolvedValue([]);
    useProjectActionStore.setState({
      runsByThread: {},
      configurationEpochByWorkspace: {},
      updateEpochByThread: {},
      updateEpochByThreadAction: {},
      hydrationByThread: {},
    });
    useTerminalStore.setState({ terminals: {}, activeTerminalByScope: {}, ptyToThread: {} });
    useWorkspaceStore.setState({ threads: [{ id: THREAD_ID, workspace_id: WORKSPACE_ID } as never] });
    useToastStore.setState({ toasts: [] });
    (window as unknown as { desktopBridge: unknown }).desktopBridge = undefined;
  });

  describe("tiles", () => {
    it("opens the run's own port from a running tile", async () => {
      seedRuns(actionRun({ port: actionPort() }));
      const onOpen = renderPage();
      const running = tile("web");

      expect(running).toHaveAttribute("data-state", "running");
      expect(running).toHaveTextContent(":5173");
      await userEvent.click(running);

      expect(onOpen).toHaveBeenCalledWith("http://localhost:5173/");
    });

    it("opens a bracketed IPv6 address as the run reported it", async () => {
      seedRuns(actionRun({ port: actionPort({ host: "::1", url: "http://[::1]:5173/" }) }));
      const onOpen = renderPage();

      await userEvent.click(tile("web"));

      expect(onOpen).toHaveBeenCalledWith("http://[::1]:5173/");
    });

    it("shows Starting without Start while a running action has not announced a port", () => {
      seedRuns(actionRun({ port: actionPort({ runId: "run-0", reachable: false }), runId: "run-1" }));
      renderPage();

      expect(tile("web")).toHaveAttribute("data-state", "starting");
      expect(within(tile("web")).getByText("Starting")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start web" })).not.toBeInTheDocument();
    });

    it("keeps a running action Starting when its own port stops answering", () => {
      seedRuns(actionRun({ port: actionPort({ reachable: false }) }));
      renderPage();

      expect(tile("web")).toHaveAttribute("data-state", "starting");
      expect(screen.queryByRole("button", { name: "Start web" })).not.toBeInTheDocument();
    });

    it("never treats a port kept from an earlier run as running", () => {
      seedRuns(actionRun({ runId: "run-2", port: actionPort({ runId: "run-1", reachable: true }) }));
      renderPage();

      expect(tile("web")).toHaveAttribute("data-state", "starting");
    });

    it("shows a stopped server with its port as history and no tile for an action that never ran", () => {
      seedRuns(stoppedRun(), actionRun({ actionId: "docs", actionName: "docs", runId: "run-9", port: null }));
      renderPage();

      expect(screen.getAllByTestId("browser-server-tile")).toHaveLength(1);
      expect(tile("web")).toHaveAttribute("data-state", "stopped");
      expect(tile("web")).toHaveTextContent(":5173");
      expect(screen.getByRole("button", { name: "Start web" })).toBeInTheDocument();
    });

    it("lists a server that starts running after the page is open without polling", async () => {
      renderPage();
      expect(screen.queryByTestId("browser-server-tile")).not.toBeInTheDocument();

      act(() => seedRuns(actionRun({ port: actionPort() })));

      expect(await screen.findByTestId("browser-server-tile")).toHaveAttribute("data-state", "running");
      expect(transport.listWorkspaceActionRuns).toHaveBeenCalledTimes(1);
    });
  });

  describe("Start", () => {
    it("restarts in the open terminal, then opens the page only after the new run reports its port", async () => {
      seedRuns(stoppedRun());
      const onOpen = renderPage();
      transport.restartWorkspaceAction.mockResolvedValue(actionRun({
        runId: "run-2",
        revision: 1,
        createdAt: "2026-08-22T12:10:00.000Z",
        port: actionPort({ runId: "run-1", reachable: false }),
      }));

      await userEvent.click(screen.getByRole("button", { name: "Start web" }));

      expect(transport.restartWorkspaceAction).toHaveBeenCalledWith(THREAD_ID, "web");
      expect(transport.startWorkspaceAction).not.toHaveBeenCalled();
      await waitFor(() => expect(tile("web")).toHaveAttribute("data-state", "starting"));
      expect(onOpen).not.toHaveBeenCalled();

      act(() => seedRuns(actionRun({
        runId: "run-2",
        revision: 2,
        createdAt: "2026-08-22T12:10:00.000Z",
        port: actionPort({ runId: "run-2", url: "http://localhost:5173/" }),
      })));

      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
      expect(onOpen).toHaveBeenCalledWith("http://localhost:5173/");
    });

    it("starts a new run when the terminal is closed", async () => {
      seedRuns(stoppedRun({ terminalSessionId: null }));
      renderPage();
      transport.startWorkspaceAction.mockResolvedValue(actionRun({
        runId: "run-2",
        createdAt: "2026-08-22T12:10:00.000Z",
        terminalSessionId: "pty-2",
        port: actionPort({ runId: "run-1", reachable: false }),
      }));

      await userEvent.click(screen.getByRole("button", { name: "Start web" }));

      expect(transport.startWorkspaceAction).toHaveBeenCalledWith(THREAD_ID, "web");
      expect(transport.restartWorkspaceAction).not.toHaveBeenCalled();
    });

    it("does not open the port kept from the earlier run while the new run is still Starting", async () => {
      seedRuns(stoppedRun());
      const onOpen = renderPage();
      transport.restartWorkspaceAction.mockResolvedValue(actionRun({
        runId: "run-2",
        createdAt: "2026-08-22T12:10:00.000Z",
        port: actionPort({ runId: "run-1", reachable: false }),
      }));

      await userEvent.click(screen.getByRole("button", { name: "Start web" }));

      await waitFor(() => expect(tile("web")).toHaveAttribute("data-state", "starting"));
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("returns to Stopped with a toast when the start request fails", async () => {
      seedRuns(stoppedRun());
      const onOpen = renderPage();
      transport.restartWorkspaceAction.mockRejectedValue(new Error("terminal gone"));

      await userEvent.click(screen.getByRole("button", { name: "Start web" }));

      await waitFor(() => expect(tile("web")).toHaveAttribute("data-state", "stopped"));
      expect(useToastStore.getState().toasts[0]).toMatchObject({ title: "Couldn't start web. Try again." });
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe("recent pages", () => {
    const NOW = Date.now();
    const history: BrowserHistory = {
      entries: [
        { url: "https://example.com/docs", title: "Docs", faviconUrl: null, lastVisitedAt: NOW - 3 * 3_600_000 },
        { url: "http://localhost:5173/settings", title: "Settings", faviconUrl: null, lastVisitedAt: NOW - 2 * 60_000 },
      ],
      thumbnails: [],
    };

    it("lists newest first, naming a loopback page after the server on its port", async () => {
      seedRuns(stoppedRun());
      installHistory(history);
      renderPage();

      const rows = await screen.findAllByTestId("browser-recent-page");

      expect(rows.map((row) => row.textContent)).toEqual([
        "Settingsweb /settings2m",
        "Docsexample.com /docs3h",
      ]);
    });

    it("opens a recent page on click", async () => {
      installHistory(history);
      const onOpen = renderPage();

      await userEvent.click(await screen.findByRole("button", { name: "Open Docs" }));

      expect(onOpen).toHaveBeenCalledWith("https://example.com/docs");
    });

    it("removes a page and reloads the list", async () => {
      const bridge = installHistory(history);
      renderPage();
      bridge.list.mockResolvedValue({ entries: [history.entries[1]!], thumbnails: [] });

      await userEvent.click(await screen.findByRole("button", { name: "Remove Docs from recent pages" }));

      expect(bridge.remove).toHaveBeenCalledWith(WORKSPACE_ID, "https://example.com/docs");
      await waitFor(() => expect(screen.queryByRole("button", { name: "Open Docs" })).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Open Settings" })).toBeInTheDocument();
    });

    it("shows a server's last view as its thumbnail", async () => {
      seedRuns(actionRun({ port: actionPort() }));
      installHistory({
        entries: [],
        thumbnails: [{ origin: "http://127.0.0.1:5173", capturedAt: NOW, dataUrl: "data:image/jpeg;base64,AAAA" }],
      });
      renderPage();

      await waitFor(() => expect(tile("web").querySelector("img")).toHaveAttribute("src", "data:image/jpeg;base64,AAAA"));
    });
  });

  describe("without a thread or a desktop bridge", () => {
    it("shows recent pages only in a threadless Browser", async () => {
      seedRuns(actionRun({ port: actionPort() }));
      installHistory({
        entries: [{ url: "https://example.com/", title: "Example", faviconUrl: null, lastVisitedAt: Date.now() }],
        thumbnails: [],
      });
      renderPage(vi.fn(), WORKSPACE_ID);

      expect(await screen.findByRole("button", { name: "Open Example" })).toBeInTheDocument();
      expect(screen.queryByTestId("browser-server-tile")).not.toBeInTheDocument();
      expect(transport.listWorkspaceActionRuns).not.toHaveBeenCalled();
    });

    it("shows tiles without thumbnails or recent pages in the web runtime", () => {
      seedRuns(actionRun({ port: actionPort() }));
      renderPage();

      expect(tile("web").querySelector("img")).toBeNull();
      expect(screen.queryByRole("list", { name: "Recent pages" })).not.toBeInTheDocument();
    });
  });
});
