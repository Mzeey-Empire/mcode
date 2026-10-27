import { createMockThread } from "@mcode/contracts/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabInfo, WorkspaceEnvironmentActionRun } from "@mcode/contracts";


const transport = vi.hoisted(() => ({
  listWorkspaceActionRuns: vi.fn(),
  startWorkspaceAction: vi.fn(),
  restartWorkspaceAction: vi.fn(),
}));

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => transport,
}));

import { browserAutomationTargetKey, useBrowserAutomationStore, usePreviewTabsStore } from "@/features/preview";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import type { ThreadOverviewBrowserTab } from "@/features/thread-overview/entries/browser";
import { ThreadOverviewBrowserRow } from "@/features/thread-overview/entries/ThreadOverviewBrowserRow";

const THREAD = createMockThread({ id: "thread-1", workspace_id: "ws-1" });

function page(id: string, url: string, title: string, faviconUrl: string | null = null): ThreadOverviewBrowserTab {
  const tab: BrowserTabInfo = { id, threadId: THREAD.id, title, url, faviconUrl, warm: true, active: false };
  return { tab, controller: undefined };
}

function liveTarget(tabId: string) {
  return [
    browserAutomationTargetKey("ws-1", THREAD.id, tabId),
    { workspaceId: "ws-1", threadId: THREAD.id, tabId, revision: 1, lastUsedAt: 1 },
  ] as const;
}

function agentActs(tabId: string, request: { operation: string; args: object }): void {
  const key = browserAutomationTargetKey("ws-1", THREAD.id, tabId);
  useBrowserAutomationStore.setState({
    liveTargets: new Map([liveTarget(tabId)]),
    controllers: new Map([[key, { tabId, controller: "agent", controlEpoch: 1 }]]),
    actingTargets: new Set([key]),
    activeRequests: new Map([["req-1", {
      startedAt: 1,
      dispatch: { request, target: { threadId: THREAD.id, tabId } } as never,
    }]]),
  });
}

function userHolds(tabId: string): void {
  useBrowserAutomationStore.setState({
    liveTargets: new Map([liveTarget(tabId)]),
    controllers: new Map([[
      browserAutomationTargetKey("ws-1", THREAD.id, tabId),
      { tabId, controller: "human", controlEpoch: 2 },
    ]]),
  });
}

function webRun(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: THREAD.id,
    workspaceId: "ws-1",
    actionId: "web",
    runId: "run-1",
    revision: 1,
    terminalSessionId: "pty-1",
    trigger: "manual",
    port: {
      runId: "run-1",
      port: 5173,
      host: "localhost",
      url: "http://localhost:5173/",
      reachable: false,
      detectedAt: "2026-08-22T12:00:02.000Z",
    },
    actionName: "web",
    status: "interrupted",
    snapshot: { platform: "linux", script: "bun run dev", checkoutPath: "/repo", terminal: null, environmentNames: [] },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: "2026-08-22T12:05:00.000Z",
    exitCode: null,
    ...overrides,
  };
}

function seedRuns(...runs: WorkspaceEnvironmentActionRun[]): void {
  for (const run of runs) useProjectActionStore.getState().applyRun(run);
  transport.listWorkspaceActionRuns.mockResolvedValue(Object.values(useProjectActionStore.getState().runsByThread[THREAD.id] ?? {}));
}

function renderRow(pages: readonly ThreadOverviewBrowserTab[], activeTabId: string | null = pages[0]?.tab.id ?? null) {
  return render(<ThreadOverviewBrowserRow thread={THREAD} pages={pages} activeTabId={activeTabId} />);
}

const row = () => screen.getByTestId("thread-overview-browser");

describe("overview Browser row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.listWorkspaceActionRuns.mockResolvedValue([]);
    useBrowserAutomationStore.setState({
      liveTargets: new Map(),
      controllers: new Map(),
      actingTargets: new Set(),
      activeRequests: new Map(),
      pendingAgentOpens: new Map(),
    });
    useProjectActionStore.setState({
      runsByThread: {},
      configurationEpochByWorkspace: {},
      updateEpochByThread: {},
      updateEpochByThreadAction: {},
      hydrationByThread: {},
    });
  });

  it("names the page host and counts the other pages when the agent is idle", () => {
    renderRow([
      page("a", "https://app.example.test/dashboard", "Dashboard"),
      page("b", "https://docs.example.test/", "Docs"),
      page("c", "https://example.test/", "Home"),
    ]);

    expect(row()).toHaveAttribute("data-state", "open");
    expect(row()).toHaveTextContent("Dashboard");
    expect(row()).toHaveTextContent("app.example.test");
    expect(screen.getByTestId("thread-overview-browser-more")).toHaveTextContent("+2");
    expect(screen.queryByRole("button", { name: "Hand back" })).not.toBeInTheDocument();
  });

  it("follows the Browser's active page and shows no count for a single page", () => {
    renderRow([page("a", "https://a.test/", "A page"), page("b", "https://b.test/", "B page")], "b");
    expect(row()).toHaveTextContent("B page");
    expect(screen.getByTestId("thread-overview-browser-more")).toHaveTextContent("+1");
  });

  it("shows no count when the thread has one page", () => {
    renderRow([page("only", "https://only.test/", "Only page")]);
    expect(screen.queryByTestId("thread-overview-browser-more")).not.toBeInTheDocument();
  });

  it("shows the live step with the element name while the agent clicks a role target", () => {
    agentActs("a", { operation: "click", args: { target: { role: "button", accessibleName: "Update" } } });
    renderRow([page("a", "https://app.example.test/", "Dashboard")]);

    expect(row()).toHaveAttribute("data-state", "acting");
    expect(screen.getByRole("button", { name: "Browser, Clicking Update, Dashboard" })).toBeInTheDocument();
  });

  it("never prints a selector target in the live step", () => {
    agentActs("a", { operation: "click", args: { target: { cssSelector: "#delete-account" } } });
    renderRow([page("a", "https://app.example.test/", "Dashboard")]);

    expect(row()).toHaveTextContent("Clicking the page");
    expect(row()).not.toHaveTextContent("delete-account");
  });

  it("speaks for the page the agent holds even when another page is active", () => {
    agentActs("b", { operation: "scroll", args: {} });
    renderRow([page("a", "https://a.test/", "A page"), page("b", "https://b.test/", "B page")], "a");

    expect(row()).toHaveTextContent("Scrolling the page");
    expect(row()).toHaveTextContent("B page");
  });

  it("shows Paused with Hand back, and Hand back returns the row to the open state", async () => {
    userHolds("a");
    renderRow([page("a", "https://app.example.test/", "Dashboard")]);

    expect(row()).toHaveAttribute("data-state", "paused");
    expect(row()).toHaveTextContent("Paused");
    await userEvent.click(screen.getByRole("button", { name: "Hand back" }));

    await waitFor(() => expect(row()).toHaveAttribute("data-state", "open"));
    expect(screen.queryByRole("button", { name: "Hand back" })).not.toBeInTheDocument();
  });

  it("offers Start web for a stopped project server and restarts it from the row", async () => {
    seedRuns(webRun());
    transport.restartWorkspaceAction.mockResolvedValue(webRun({ runId: "run-2", status: "running", finishedAt: null }));
    renderRow([page("a", "http://localhost:5173/", "Vite App")]);

    await waitFor(() => expect(row()).toHaveAttribute("data-state", "server-stopped"));
    expect(row()).toHaveTextContent("web isn't running");
    await userEvent.click(screen.getByRole("button", { name: "Start web" }));

    expect(transport.restartWorkspaceAction).toHaveBeenCalledWith(THREAD.id, "web");
  });

  it("makes the stopped page the active tab before starting its server", async () => {
    seedRuns(webRun());
    transport.restartWorkspaceAction.mockResolvedValue(webRun({ runId: "run-2", status: "running", finishedAt: null }));
    const activatePage = vi.spyOn(usePreviewTabsStore.getState(), "activatePage").mockResolvedValue(undefined as never);
    renderRow([page("a", "http://localhost:5173/", "Vite App"), page("b", "https://b.test/", "B page")], "a");

    await userEvent.click(await screen.findByRole("button", { name: "Start web" }));

    expect(activatePage).toHaveBeenCalledWith("ws-1", THREAD.id, "a");
    activatePage.mockRestore();
  });

  it("starts an action that never had a terminal instead of restarting it", async () => {
    seedRuns(webRun({ terminalSessionId: null }));
    transport.startWorkspaceAction.mockResolvedValue(webRun({ runId: "run-2", status: "running", finishedAt: null }));
    renderRow([page("a", "http://localhost:5173/", "Vite App")]);

    await userEvent.click(await screen.findByRole("button", { name: "Start web" }));

    expect(transport.startWorkspaceAction).toHaveBeenCalledWith(THREAD.id, "web");
    expect(transport.restartWorkspaceAction).not.toHaveBeenCalled();
  });

  it("stays open while the server answers", async () => {
    seedRuns(webRun({ status: "running", finishedAt: null, port: { ...webRun().port!, reachable: true } }));
    renderRow([page("a", "http://localhost:5173/", "Vite App")]);

    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalled());
    expect(row()).toHaveAttribute("data-state", "open");
    expect(screen.queryByRole("button", { name: "Start web" })).not.toBeInTheDocument();
  });

  it("stays open when a live server shares the port with a stopped one", async () => {
    seedRuns(
      webRun({ actionId: "api", actionName: "api" }),
      webRun({ actionId: "web", status: "running", finishedAt: null, port: { ...webRun().port!, reachable: true } }),
    );
    renderRow([page("a", "http://localhost:5173/", "Vite App")]);

    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalled());
    expect(row()).toHaveAttribute("data-state", "open");
    expect(screen.queryByRole("button", { name: /^Start/ })).not.toBeInTheDocument();
  });

  it("offers no Start when two stopped servers claim the page's port", async () => {
    seedRuns(webRun({ actionId: "api", actionName: "api" }), webRun());
    renderRow([page("a", "http://localhost:5173/", "Vite App")]);

    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalled());
    expect(row()).toHaveAttribute("data-state", "open");
    expect(screen.queryByRole("button", { name: /^Start/ })).not.toBeInTheDocument();
  });

  it("stays open for a page on a port no project server announced", async () => {
    seedRuns(webRun());
    renderRow([page("a", "http://localhost:3000/", "Other app")]);

    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalled());
    expect(row()).toHaveAttribute("data-state", "open");
    expect(screen.queryByRole("button", { name: "Start web" })).not.toBeInTheDocument();
  });

  it("lets the acting agent outrank a stopped server on the same page", async () => {
    seedRuns(webRun());
    agentActs("a", { operation: "reload", args: {} });
    renderRow([page("a", "http://localhost:5173/", "Vite App")]);

    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalled());
    expect(row()).toHaveAttribute("data-state", "acting");
    expect(screen.queryByRole("button", { name: "Start web" })).not.toBeInTheDocument();
  });

  it("does not list project servers for a thread with no loopback page", () => {
    renderRow([page("a", "https://example.test/", "Example")]);
    expect(transport.listWorkspaceActionRuns).not.toHaveBeenCalled();
  });
});
