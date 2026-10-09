import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { RecoveryIncident } from "@mcode/contracts";
import { App } from "../app/App";
import { useConnectionStore } from "@/stores/connectionStore";
import { useRecoveryIncidentStore } from "@/features/recovery/state/recoveryIncidentStore";
import { useUiStore } from "@/stores/uiStore";
import { useNavigationHistoryStore } from "@/stores/navigationHistoryStore";
import { executeCommand, getAllCommands } from "@/lib/command-registry";

const getRecoveryIncident = vi.hoisted(() => vi.fn());

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as typeof ResizeObserver;
}

// Mock the transport module to prevent WebSocket initialization during tests
vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  initTransport: vi.fn().mockResolvedValue({}),
  getTransport: () => ({
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listThreads: vi.fn().mockResolvedValue([]),
    getRecoveryIncident,
    getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    createAndSendMessage: vi
      .fn()
      .mockResolvedValue({ id: "t1", title: "test", model: null }),
    updateThreadTitle: vi.fn().mockResolvedValue(true),
    createWorkspace: vi.fn().mockResolvedValue({}),
    deleteWorkspace: vi.fn().mockResolvedValue(true),
    createThread: vi.fn().mockResolvedValue({}),
    deleteThread: vi.fn().mockResolvedValue(true),
    continueWithoutSaving: vi.fn().mockResolvedValue(undefined),
    stopAgent: vi.fn().mockImplementation((threadId: string) => Promise.resolve({
      threadId,
      turnExecutionId: null,
      snapshot: { threadId, turnExecutionId: null, phase: "idle" },
      status: "already-terminal",
      dispatchState: "unknown",
    })),
    getActiveAgentCount: vi.fn().mockResolvedValue(0),
    discoverConfig: vi.fn().mockResolvedValue({}),
    getVersion: vi.fn().mockResolvedValue("0.2.0"),
    touchLastOpened: vi.fn().mockResolvedValue(undefined),
    pinWorkspace: vi.fn().mockResolvedValue(undefined),
    removeRecent: vi.fn().mockResolvedValue(undefined),
    enrichWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
    filesystemBrowse: vi.fn().mockResolvedValue({
      path: "/",
      parent: null,
      entries: [],
      isExactDirectory: true,
    }),
    getSettings: vi.fn().mockResolvedValue({}),
    getPullRequestCapabilities: vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "unauthenticated",
        message: "GitHub authentication required",
      },
    }),
    listPullRequests: vi.fn().mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      snapshotVersion: "test",
      fetchedAt: "2026-07-11T12:00:00.000Z",
      staleAt: "2026-07-11T12:00:30.000Z",
      limitations: [],
    }),
    cancelPullRequestOperation: vi
      .fn()
      .mockResolvedValue({ ok: true, cancelled: false }),
  }),
}));

// Mock ScrollArea since @base-ui/react may not work in jsdom
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
  ScrollBar: () => null,
}));

// Keep cold transform time outside the test timeout; this suite verifies navigation, not chunk loading.
await import("@/features/pull-requests");

describe("App", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useConnectionStore.setState({ status: "connecting" });
    useRecoveryIncidentStore.setState({
      incident: null,
      dismissedIncidentIds: new Set<string>(),
      retriedExecutionIds: new Set<string>(),
    });
    delete (window as unknown as Record<string, unknown>).desktopBridge;
  });

  beforeEach(() => {
    getRecoveryIncident.mockReset();
    getRecoveryIncident.mockResolvedValue(null);
    useNavigationHistoryStore.setState({ entries: [], index: -1 });
    useUiStore.setState({
      primarySurface: "chat",
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      sidebarFloating: false,
    });
  });

  it("renders the sidebar logo", async () => {
    render(<App />);
    await waitFor(() => {
      const sidebar =
        screen.queryByTestId("sidebar-docked") ??
        screen.getByTestId("sidebar-floating");
      expect(
        within(sidebar).getByRole("img", { name: "Mcode" }),
      ).toBeInTheDocument();
    });
  });

  it("renders the landing screen when no workspace is active", async () => {
    render(<App />);
    await waitFor(() => {
      const main = screen.getByRole("main");
      expect(
        within(main).getByRole("img", { name: "Mcode" }),
      ).toBeInTheDocument();
    });
  });

  it("gives the floating sidebar an opaque page surface", () => {
    useUiStore.setState({
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      sidebarFloating: true,
    });

    render(<App />);

    const floatingSidebar = screen.getByTestId("sidebar-floating");
    expect(floatingSidebar).toHaveClass("bg-page");
    expect(floatingSidebar.firstElementChild).toHaveClass(
      "w-full",
      "max-w-none",
    );
    expect(floatingSidebar).toHaveClass(
      "animate-in",
      "slide-in-from-left-4",
      "motion-reduce:animate-none",
    );
    expect(screen.getByRole("button", { name: "Close project tree" })).toHaveClass(
      "animate-in",
      "fade-in-0",
      "motion-reduce:animate-none",
    );
  });

  it("retains the floating sidebar during its pointer-inert exit", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );
    useUiStore.setState({
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      sidebarFloating: true,
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Close project tree" }));

    const backdrop = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close project tree"]',
    );
    const floatingSidebar = screen.getByTestId("sidebar-floating");
    if (!backdrop) throw new Error("Floating sidebar backdrop was not retained");
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).toHaveAttribute("inert");
    expect(backdrop).toHaveClass("pointer-events-none", "animate-out", "fade-out-0");
    expect(floatingSidebar).toHaveAttribute("aria-hidden", "true");
    expect(floatingSidebar).toHaveAttribute("inert");
    expect(floatingSidebar).toHaveClass(
      "pointer-events-none",
      "animate-out",
      "slide-out-to-left-4",
    );

    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByTestId("sidebar-floating")).not.toBeInTheDocument();
  });

  it("removes the floating sidebar immediately with reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );
    useUiStore.setState({
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      sidebarFloating: true,
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Close project tree" }));

    expect(screen.queryByTestId("sidebar-floating")).not.toBeInTheDocument();
  });

  it("retains the collapsed docked sidebar without allowing interaction", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    const dockedSidebar = screen.getByTestId("sidebar-docked");
    expect(dockedSidebar).toBeInTheDocument();
    expect(dockedSidebar).toHaveAttribute("aria-hidden", "true");
    expect(dockedSidebar).toHaveAttribute("inert");
    expect(dockedSidebar).toHaveClass(
      "pointer-events-none",
      "grid-cols-[0fr]",
      "motion-reduce:transition-none",
    );
  });

  it("opens the lazy Pull requests surface from primary navigation", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Pull requests" }));

    await waitFor(() => {
      expect(
        within(screen.getByRole("main")).getByRole("heading", {
          name: "Pull requests",
        }),
      ).toBeInTheDocument();
    });
  });

  it("loads the recovery incident while Settings replaces the chat surface", async () => {
    const incident: RecoveryIncident = {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: "2026-09-01T12:00:00.000Z",
      entries: [{
        workspaceId: "workspace-1",
        workspaceName: "Project A",
        threadId: "thread-1",
        threadTitle: "Thread A",
        executionId: "00000000-0000-4000-8000-000000000002",
        startedAt: "2026-09-01T11:59:00.000Z",
        interruptedAt: "2026-09-01T12:00:00.000Z",
        durationMs: 60_000,
      }],
    };
    getRecoveryIncident.mockResolvedValue(incident);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("button", { name: "Back to chat" });

    act(() => useConnectionStore.setState({ status: "connected" }));

    await waitFor(() => {
      expect(getRecoveryIncident).toHaveBeenCalledTimes(1);
      expect(useRecoveryIncidentStore.getState().incident).toEqual(incident);
    });
  });

  it("returns from Settings to Chat instead of the previous surface", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Pull requests" }));
    await screen.findByRole("heading", { name: "Pull requests" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Back to chat" }),
    );

    await waitFor(() => {
      expect(
        within(screen.getByRole("main")).getByText("What should we work on?"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Pull requests" }),
    ).not.toBeInTheDocument();
  });

  function installDesktopWindow(isDevelopment: boolean) {
    let commandListener: ((command: string) => void) | undefined;
    const perform = vi.fn().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).desktopBridge = {
      window: {
        platform: "win32",
        isDevelopment,
        perform,
        onFullScreenChange: () => () => {},
        onCommand: (callback: (command: string) => void) => {
          commandListener = callback;
          return callback;
        },
        offCommand: vi.fn(),
      },
    };
    return { perform, sendCommand: (command: string) => commandListener?.(command) };
  }

  it("renders no title bar on desktop, only the shared header strip", () => {
    installDesktopWindow(false);

    render(<App />);

    const headers = [...document.querySelectorAll("header")];
    expect(headers.map((header) => header.dataset.testid ?? ("canvasHeader" in header.dataset ? "canvas" : "other"))).toEqual(["sidebar-header", "canvas"]);
    expect(screen.queryByRole("menubar")).not.toBeInTheDocument();
    const header = screen.getByTestId("sidebar-header");
    expect(within(header).getByRole("button", { name: "Back" })).toBeDisabled();
    expect(within(header).getByRole("button", { name: "Forward" })).toBeDisabled();
    expect(document.documentElement).toHaveAttribute("data-window-chrome", "caption-overlay");
  });

  it("gives the canvas header the sidebar controls once the sidebar collapses", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    const canvasHeader = document.querySelector("[data-canvas-header]");
    expect(canvasHeader).not.toBeNull();
    expect(within(canvasHeader as HTMLElement).getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(within(canvasHeader as HTMLElement).getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("keeps the reconnect banner below the canvas header", () => {
    useConnectionStore.setState({ status: "reconnecting" });

    render(<App />);

    const canvasHeader = document.querySelector("[data-canvas-header]");
    const banner = screen.getByText("Reconnecting to server");
    expect(canvasHeader).not.toBeNull();
    expect(
      (canvasHeader as HTMLElement).compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("routes desktop menu commands through the command registry", () => {
    const { perform, sendCommand } = installDesktopWindow(false);

    render(<App />);
    act(() => sendCommand("window.zoomIn"));
    act(() => sendCommand("window.toggleFullScreen"));

    expect(perform.mock.calls).toEqual([["zoomIn"], ["toggleFullScreen"]]);
  });

  it("opens Settings sections from the palette commands on every platform", async () => {
    render(<App />);

    act(() => {
      executeCommand("settings.about");
    });

    expect(await screen.findByRole("button", { name: "Back to chat" })).toBeInTheDocument();
  });

  it.each([
    [false, ["window.toggleFullScreen", "window.zoomIn", "window.zoomOut", "window.zoomReset"]],
    [true, ["window.reload", "window.toggleDevTools", "window.toggleFullScreen", "window.zoomIn", "window.zoomOut", "window.zoomReset"]],
  ])("registers the window commands (development %s)", (isDevelopment, expected) => {
    installDesktopWindow(isDevelopment);

    render(<App />);

    const ids = getAllCommands().map((command) => command.id).filter((id) => id.startsWith("window.")).sort();
    expect(ids).toEqual(expected);
  });

  it("registers no window commands for a partial feature bridge", () => {
    (window as unknown as Record<string, unknown>).desktopBridge = {
      preview: {},
    };

    render(<App />);

    expect(getAllCommands().some((command) => command.id.startsWith("window."))).toBe(false);
    expect(document.documentElement).toHaveAttribute("data-window-chrome", "web");
  });
});
