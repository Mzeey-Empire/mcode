import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewDisplayTabSet, usePreviewTabsStore } from "../../state/previewTabsStore";
import { BrowserTabStrip } from "../BrowserTabStrip";

const WORKSPACE = "workspace-1";
const THREAD = "thread-1";

function page(id: string, title: string): BrowserTabInfo {
  return { id, threadId: THREAD, title, url: null, faviconUrl: null, warm: true, active: false };
}

function installFakeTabTransport(initial: readonly BrowserTabInfo[]) {
  let pages = [...initial];
  let activeTabId: string | null = pages[0]?.id ?? null;
  let opened = 0;
  const calls: string[] = [];
  const snapshot = (): BrowserTabSet => ({
    threadId: THREAD,
    activeTabId,
    tabs: pages.map((tab) => ({ ...tab, active: tab.id === activeTabId })),
  });
  const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
  const tabs = {
    open: () => {
      opened += 1;
      const tabId = `new-${opened}`;
      calls.push(`open:${tabId}`);
      pages = [...pages, page(tabId, "")];
      activeTabId = tabId;
      return ok({ tabId, tabs: snapshot() });
    },
    activate: (_threadId: string, _workspaceId: string, tabId: string) => {
      calls.push(`activate:${tabId}`);
      activeTabId = tabId;
      return ok(snapshot());
    },
    close: (_threadId: string, _workspaceId: string, tabId: string) => {
      calls.push(`close:${tabId}`);
      pages = pages.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) activeTabId = pages[0]?.id ?? null;
      return ok(snapshot());
    },
    closeScope: () => {
      calls.push("closeScope");
      pages = [];
      activeTabId = null;
      return ok(snapshot());
    },
    list: () => ok(snapshot()),
    onUpdated: () => () => {},
  };
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: { preview: { tabs } } });
  usePreviewTabsStore.getState().setTabSet(WORKSPACE, THREAD, snapshot());
  return { calls };
}

function Harness() {
  const tabSet = usePreviewDisplayTabSet(THREAD, WORKSPACE);
  return <BrowserTabStrip workspaceId={WORKSPACE} threadId={THREAD} scopeId={THREAD} tabSet={tabSet} />;
}

function selectedPage(): string | null {
  return screen.queryAllByRole("button", { pressed: true })[0]?.textContent ?? null;
}

function pageNames(): string[] {
  return screen.queryAllByRole("group", { name: "Browser pages" })
    .flatMap((strip) => [...strip.querySelectorAll("button[aria-pressed]")])
    .map((button) => button.textContent ?? "");
}

describe("BrowserTabStrip", () => {
  beforeEach(() => {
    usePreviewTabsStore.setState({
      tabSetByScope: {},
      liveChromeByScope: {},
      persistentTabIdsByScope: {},
      pendingNavErrorsByScope: {},
    });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
    useDiffStore.getState().setRightPanelTab(WORKSPACE, THREAD, "preview");
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: undefined });
  });

  it("selects, closes and adds pages in its own scope", async () => {
    const { calls } = installFakeTabTransport([page("a", "Docs"), page("b", "Dashboard")]);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
    await waitFor(() => expect(selectedPage()).toBe("Dashboard"));
    fireEvent.click(screen.getByRole("button", { name: "Close Dashboard" }));
    await waitFor(() => expect(pageNames()).toEqual(["Docs"]));
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    await waitFor(() => expect(selectedPage()).toBe("New page"));

    expect(calls).toEqual(["activate:b", "close:b", "open:new-1"]);
    expect(pageNames()).toEqual(["Docs", "New page"]);
  });

  it("closes an inactive page without selecting it first", async () => {
    const { calls } = installFakeTabTransport([page("a", "Docs"), page("b", "Dashboard")]);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Close Dashboard" }));
    await waitFor(() => expect(pageNames()).toEqual(["Docs"]));

    expect(calls).toEqual(["close:b"]);
    expect(selectedPage()).toBe("Docs");
  });

  it("closes the Browser tool when its last page closes", async () => {
    installFakeTabTransport([page("a", "Docs")]);
    render(<Harness />);
    expect(useDiffStore.getState().getRightPanel(WORKSPACE, THREAD).openTabs).toEqual(["preview"]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close Docs" }));
    });

    expect(useDiffStore.getState().getRightPanel(WORKSPACE, THREAD).openTabs).toEqual([]);
    expect(pageNames()).toEqual([]);
  });
});
