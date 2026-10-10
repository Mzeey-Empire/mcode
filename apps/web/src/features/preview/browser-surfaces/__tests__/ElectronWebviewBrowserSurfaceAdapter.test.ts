import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createElectronWebviewBrowserSurfaceAdapterFactory,
  ElectronWebviewBrowserSurfaceAdapter,
  normalizeElectronWebviewSurfaceAddress,
} from "../ElectronWebviewBrowserSurfaceAdapter";
import {
  BrowserSurfaceHost,
  type BrowserSurfaceAdapterEvent,
  type BrowserSurfaceIdentity,
} from "../BrowserSurfaceHost";
import type { PreviewSurfaceBridge, PreviewSurfaceBridgeResult, PreviewTabsBridge } from "@/transport/desktop-bridge";
import { runBrowserSurfaceContract } from "./browserSurfaceContract";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  scope: { kind: "thread", id: "thread-electron" },
  tabId: "tab-electron",
};

function bridge(): PreviewSurfaceBridge & {
  prepare: ReturnType<typeof vi.fn>;
  adopt: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  hidden: ReturnType<typeof vi.fn>;
} {
  return {
    prepare: vi.fn().mockResolvedValue({ ok: true }),
    adopt: vi.fn().mockResolvedValue({ ok: true }),
    navigate: vi.fn().mockResolvedValue({ ok: true }),
    release: vi.fn().mockResolvedValue({ ok: true }),
    hidden: vi.fn().mockResolvedValue({ ok: true }),
    onPopupRequested: vi.fn(() => () => undefined),
    onDiscardRequested: vi.fn(() => () => undefined),
  };
}

runBrowserSurfaceContract(
  "Electron webview BrowserSurfaceHost contract",
  createElectronWebviewBrowserSurfaceAdapterFactory({ root: document.body, bridge: bridge() }),
);

it("notifies main once per hide transition and retains the adopted guest until close capture finishes", async () => {
  const surfaceBridge = bridge();
  const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 9, { root: document.body, bridge: surfaceBridge });
  await vi.waitFor(() => expect(adapter.element.isConnected).toBe(true));
  adapter.element.dispatchEvent(new Event("did-attach"));
  await adapter.navigate("http://localhost:5173/fixture");
  adapter.present({ left: 0, top: 0, width: 640, height: 480 });
  adapter.hide();
  adapter.hide();
  expect(surfaceBridge.hidden.mock.calls).toEqual([[{ surface: { identity: IDENTITY, generation: 9 } }]]);
  let finish: (result: PreviewSurfaceBridgeResult) => void = () => { throw new Error("release not started"); };
  surfaceBridge.release.mockImplementation(() => new Promise<PreviewSurfaceBridgeResult>((resolve) => { finish = resolve; }));
  adapter.dispose();
  expect(adapter.element.isConnected).toBe(true);
  expect(adapter.element.style.pointerEvents).toBe("none");
  expect(surfaceBridge.release.mock.calls).toEqual([[{ surface: { identity: IDENTITY, generation: 9 }, reason: "dispose" }]]);
  finish({ ok: true });
  await vi.waitFor(() => expect(adapter.element.isConnected).toBe(false));
});

describe("ElectronWebviewBrowserSurfaceAdapter", () => {
  afterEach(() => vi.useRealTimers());

  it("adopts a cold guest after early discovery expires without reporting a load failure", async () => {
    vi.useFakeTimers();
    const surfaceBridge = bridge();
    surfaceBridge.adopt.mockResolvedValue({ ok: false, error: "guest-not-found" });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, { bridge: surfaceBridge });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const navigation = adapter.navigate("https://example.test/cold");
    await vi.advanceTimersByTimeAsync(3_000);
    const discoveryCalls = surfaceBridge.adopt.mock.calls.length;
    expect(discoveryCalls).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(surfaceBridge.adopt).toHaveBeenCalledTimes(discoveryCalls);
    expect(events.filter((event) => event.type === "load-failed")).toEqual([]);
    surfaceBridge.adopt.mockResolvedValue({ ok: true });
    adapter.element.dispatchEvent(new Event("did-attach"));
    await navigation;
    expect(surfaceBridge.adopt).toHaveBeenCalledTimes(discoveryCalls + 1);
    expect(surfaceBridge.navigate.mock.calls).toEqual([[{
      surface: { identity: IDENTITY, generation: 1 },
      navigation: { kind: "address", address: "https://example.test/cold" },
    }]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.filter((event) => event.type === "load-failed")).toEqual([]);
    adapter.dispose();
  });

  it("settles current and future navigation when preparation rejects a stale generation", async () => {
    const surfaceBridge = bridge();
    let finish: (result: PreviewSurfaceBridgeResult) => void = () => { throw new Error("prepare not called"); };
    surfaceBridge.prepare.mockImplementation(() => new Promise<PreviewSurfaceBridgeResult>((resolve) => { finish = resolve; }));
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, { bridge: surfaceBridge });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    adapter.create();
    const navigation = adapter.navigate("https://example.test/stale");
    finish({ ok: false, error: "stale-generation", nextGeneration: 12 });
    await navigation;
    await adapter.navigate("https://example.test/also-stale");
    expect(events.filter((event) => event.type === "load-failed")).toHaveLength(2);
    expect(events.filter((event) => event.type === "surface-lost")).toEqual([{
      type: "surface-lost", identity: IDENTITY, generation: 1, nextGeneration: 12,
    }]);
    expect(surfaceBridge.adopt).not.toHaveBeenCalled();
    expect(surfaceBridge.navigate).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("adopts when did-attach extends a discovery loop that is still running", async () => {
    vi.useFakeTimers();
    const surfaceBridge = bridge();
    surfaceBridge.adopt.mockResolvedValue({ ok: false, error: "guest-not-found" });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, { bridge: surfaceBridge });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const navigation = adapter.navigate("https://example.test/slow-discovery");
    await vi.advanceTimersByTimeAsync(1_500);
    const earlyCalls = surfaceBridge.adopt.mock.calls.length;
    adapter.element.dispatchEvent(new Event("did-attach"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(surfaceBridge.adopt.mock.calls.length).toBeGreaterThan(earlyCalls);
    expect(events.filter((event) => event.type === "load-failed")).toEqual([]);
    surfaceBridge.adopt.mockResolvedValue({ ok: true });
    await vi.advanceTimersByTimeAsync(100);
    await navigation;
    expect(surfaceBridge.navigate.mock.calls).toEqual([[{
      surface: { identity: IDENTITY, generation: 1 },
      navigation: { kind: "address", address: "https://example.test/slow-discovery" },
    }]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.filter((event) => event.type === "load-failed")).toEqual([]);
    adapter.dispose();
  });

  it("waits for main to register the workspace tab set before preparing", async () => {
    const surfaceBridge = bridge();
    let finish: (result: Awaited<ReturnType<PreviewTabsBridge["list"]>>) => void = () => { throw new Error("list not called"); };
    const list = vi.fn<PreviewTabsBridge["list"]>(() => new Promise((resolve) => { finish = resolve; }));
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, { bridge: surfaceBridge, tabsBridge: { list } });
    expect(list.mock.calls).toEqual([[IDENTITY.scope.id, IDENTITY.workspaceId]]);
    expect(surfaceBridge.prepare).not.toHaveBeenCalled();
    expect(adapter.element.isConnected).toBe(false);
    finish({ ok: true, data: { threadId: IDENTITY.scope.id, activeTabId: IDENTITY.tabId, tabs: [] } });
    await vi.waitFor(() => expect(adapter.element.isConnected).toBe(true));
    expect(surfaceBridge.prepare.mock.calls).toEqual([[{
      surface: { identity: IDENTITY, generation: 1 },
      adoptionToken: adapter.element.getAttribute("src")!.slice("about:blank#".length),
    }]]);
    adapter.dispose();
  });

  it.each(["surface-owner-mismatch", "stale-generation"])("keeps the host failed when navigation follows %s preparation failure", async (error) => {
    const surfaceBridge = bridge();
    surfaceBridge.prepare.mockResolvedValue({ ok: false, error });
    const host = new BrowserSurfaceHost({
      adapterFactory: createElectronWebviewBrowserSurfaceAdapterFactory({ bridge: surfaceBridge }),
      normalizeAddress: normalizeElectronWebviewSurfaceAddress,
    });
    host.ensure(IDENTITY);
    await vi.waitFor(() => expect(host.getSnapshot(IDENTITY)?.phase).toBe("error"));
    host.navigate(IDENTITY, "https://example.test/unavailable");
    expect(host.getSnapshot(IDENTITY)?.phase).toBe("error");
    expect(surfaceBridge.adopt).not.toHaveBeenCalled();
    expect(surfaceBridge.navigate).not.toHaveBeenCalled();
    host.disposeHost();
  });

  it("reports tab registration failure without preparing or attaching", async () => {
    const surfaceBridge = bridge();
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, {
      bridge: surfaceBridge,
      tabsBridge: { list: vi.fn().mockResolvedValue({ ok: false, error: "no-window" }) },
    });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.navigate("https://example.test/unregistered");
    expect(events.filter((event) => event.type === "load-failed")).toEqual([{
      type: "load-failed", mainFrame: true, error: "Preview is unavailable", identity: IDENTITY, generation: 1,
    }]);
    expect(surfaceBridge.prepare).not.toHaveBeenCalled();
    expect(adapter.element.isConnected).toBe(false);
    adapter.dispose();
  });

  it("appends only after prepare succeeds and uses the workspace partition", async () => {
    const surfaceBridge = bridge();
    let finish: (result: { ok: true }) => void = () => { throw new Error("prepare not called"); };
    surfaceBridge.prepare.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, { root: document.body, bridge: surfaceBridge });
    expect(adapter.element.isConnected).toBe(false);
    expect(adapter.element.getAttribute("partition")).toBe("persist:mcode-browser-11111111-1111-4111-8111-111111111111");
    finish({ ok: true });
    await vi.waitFor(() => expect(adapter.element.isConnected).toBe(true));
    adapter.dispose();
  });

  it("reports a rejected preparation without appending the webview", async () => {
    const surfaceBridge = bridge();
    surfaceBridge.prepare.mockResolvedValue({ ok: false, error: "invalid-surface" });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, { root: document.body, bridge: surfaceBridge });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await vi.waitFor(() => expect(events).toContainEqual({
      type: "load-failed", mainFrame: true, error: "Preview is unavailable", identity: IDENTITY, generation: 1,
    }));
    expect(adapter.element.isConnected).toBe(false);
    expect(surfaceBridge.adopt).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("reports an attachment that never emits did-attach", async () => {
    vi.useFakeTimers();
    const surfaceBridge = bridge();
    surfaceBridge.adopt.mockResolvedValue({ ok: false, error: "guest-not-found" });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, { root: document.body, bridge: surfaceBridge });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const navigation = adapter.navigate("https://example.test/refused");
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await navigation;
      expect(events.filter((event) => event.type === "load-failed")).toEqual([{
        type: "load-failed", mainFrame: true, error: "Preview is unavailable", identity: IDENTITY, generation: 1,
      }]);
      expect(surfaceBridge.navigate).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
      vi.useRealTimers();
    }
  });

  it("does not retain its private adoption URL when a cold tab is restored", () => {
    const adapters: ElectronWebviewBrowserSurfaceAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: (identity, generation) => {
        const adapter = new ElectronWebviewBrowserSurfaceAdapter(identity, generation, {
          root: document.body,
          bridge: bridge(),
        });
        adapters.push(adapter);
        return adapter;
      },
      normalizeAddress: normalizeElectronWebviewSurfaceAddress,
    });

    const first = host.create(IDENTITY);
    const inertAddress = adapters[0]!.element.getAttribute("src")!;
    adapters[0]!.element.dispatchEvent(Object.assign(new Event("did-navigate"), {
      url: inertAddress,
      isMainFrame: true,
    }));
    adapters[0]!.element.dispatchEvent(Object.assign(new Event("did-stop-loading"), {
      url: inertAddress,
      isMainFrame: true,
    }));

    expect(host.inspect(IDENTITY)?.recoveryAddress).toBeNull();
    expect(host.discard(IDENTITY, first.generation)).toBe(true);
    expect(() => host.ensure(IDENTITY)).not.toThrow();
    expect(adapters).toHaveLength(2);
    host.disposeHost();
  });

  it("starts inert, adopts with an opaque complete identity, and navigates through the typed bridge", async () => {
    const surfaceBridge = bridge();
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 7, {
      root: document.body,
      bridge: surfaceBridge,
    });
    const element = adapter.element;
    const inertSource = element.getAttribute("src");

    expect(element.tagName).toBe("WEBVIEW");
    expect(element.getAttribute("src")).toMatch(/^about:blank#[A-Za-z0-9_-]+$/);
    expect(element.hasAttribute("allowpopups")).toBe(true);
    expect(surfaceBridge.prepare).toHaveBeenCalledWith(expect.objectContaining({
      surface: { identity: IDENTITY, generation: 7 },
      adoptionToken: expect.any(String),
    }));
    expect(surfaceBridge.prepare.mock.calls[0]?.[0]).not.toHaveProperty("webContentsId");

    const pending = adapter.navigate("https://example.test/next");
    expect(surfaceBridge.navigate).not.toHaveBeenCalled();
    element.dispatchEvent(new Event("did-attach"));
    await pending;
    await vi.waitFor(() => expect(surfaceBridge.adopt).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(surfaceBridge.navigate).toHaveBeenCalledTimes(1));
    expect(surfaceBridge.adopt).toHaveBeenCalledWith(expect.objectContaining({
      surface: { identity: IDENTITY, generation: 7 },
      adoptionToken: surfaceBridge.prepare.mock.calls[0]?.[0].adoptionToken,
    }));
    expect(surfaceBridge.navigate).toHaveBeenCalledWith({
      surface: { identity: IDENTITY, generation: 7 },
      navigation: { kind: "address", address: "https://example.test/next" },
    });
    expect(surfaceBridge.navigate.mock.calls[0]?.[0]).not.toHaveProperty("webContentsId");
    expect(element.getAttribute("src")).toBe(inertSource);
    adapter.dispose();
  });

  it("emits generation-bound semantic events and owns presentation and disposal", () => {
    const surfaceBridge = bridge();
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 3, {
      root: document.body,
      bridge: surfaceBridge,
    });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    Object.assign(adapter.element, {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
    });
    const zIndex = 42;
    adapter.present({ left: 10, top: 20, width: 640, height: 480, scale: 1.25, zIndex, coveredLeft: 112 });
    expect(adapter.element.style.left).toBe("10px");
    expect(adapter.element.style.width).toBe("640px");
    expect(adapter.element.style.zIndex).toBe("42");
    expect(adapter.element.style.clipPath).toBe(
      "inset(0px 0px 0px 112px round 0px 0px 0px 0px)",
    );
    adapter.present({ left: 10, top: 20, width: 640, height: 480, coveredLeft: 0 });
    expect(adapter.element.style.clipPath).toBe(
      "inset(0px 0px 0px 0px round var(--radius-md) 0px 0px 0px)",
    );
    adapter.hide();
    expect(adapter.element.style.visibility).toBe("hidden");

    adapter.element.dispatchEvent(Object.assign(new Event("did-start-loading"), {
      url: "https://example.test/loading",
      isMainFrame: true,
    }));
    adapter.element.dispatchEvent(Object.assign(new Event("did-navigate"), {
      url: "https://example.test/loaded",
      isMainFrame: true,
    }));
    adapter.element.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "Example" }));
    adapter.element.dispatchEvent(Object.assign(new Event("page-favicon-updated"), { favicons: ["https://example.test/icon.png"] }));
    adapter.element.dispatchEvent(new Event("render-process-gone"));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "load-started", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "navigation-committed", address: "https://example.test/loaded", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "title-updated", title: "Example", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "favicon-updated", favicon: "https://example.test/icon.png", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "surface-lost", identity: IDENTITY, generation: 3 }),
    ]));
    adapter.dispose();
    expect(surfaceBridge.release).toHaveBeenCalledWith({
      surface: { identity: IDENTITY, generation: 3 },
      reason: "dispose",
    });
    expect(document.body.contains(adapter.element)).toBe(false);
    expect(() => adapter.element.dispatchEvent(new Event("did-navigate"))).not.toThrow();
  });

  it("applies explicit input and accessibility state", () => {
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 8, {
      root: document.body,
      bridge: bridge(),
    });

    adapter.present({ left: 0, top: 0, width: 640, height: 480, inputEnabled: false, accessible: false });
    expect(adapter.element.style.pointerEvents).toBe("none");
    expect(adapter.element).toHaveAttribute("aria-hidden", "true");

    adapter.present({ left: 0, top: 0, width: 640, height: 480, inputEnabled: true, accessible: true });
    expect(adapter.element.style.pointerEvents).toBe("auto");
    expect(adapter.element).toHaveAttribute("aria-hidden", "false");
    adapter.dispose();
  });

  it("places the agent-control edge blur above the webview without catching input", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 9, {
      root,
      bridge: bridge(),
    });
    const zIndex = 31;
    adapter.present({ left: 10, top: 20, width: 640, height: 480, zIndex });

    adapter.setControlled(true);

    const indicator = root.querySelector<HTMLElement>(
      "[data-testid='browser-surface-control-indicator']",
    );
    expect(indicator).not.toBeNull();
    expect(indicator).toHaveStyle({ visibility: "visible", pointerEvents: "none" });
    expect(Number(indicator!.style.zIndex)).toBeGreaterThan(Number(adapter.element.style.zIndex));

    adapter.setControlled(false);

    expect(indicator).toHaveStyle({ visibility: "hidden" });
    adapter.dispose();
    root.remove();
  });

  it("publishes renderer history state after address, history, and in-page commits", () => {
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 4, {
      root: document.body,
      bridge: bridge(),
    });
    let canGoBack = false;
    let canGoForward = false;
    Object.assign(adapter.element, {
      canGoBack: vi.fn(() => canGoBack),
      canGoForward: vi.fn(() => canGoForward),
    });
    const navigationStates: Array<{ canGoBack: boolean; canGoForward: boolean } | null> = [];
    adapter.subscribe((event) => {
      if (event.type === "navigation-state") navigationStates.push(event.navigation);
    });

    const commit = (
      type: "did-navigate" | "did-navigate-in-page",
      address: string,
      state: { canGoBack: boolean; canGoForward: boolean },
    ): void => {
      canGoBack = state.canGoBack;
      canGoForward = state.canGoForward;
      adapter.element.dispatchEvent(Object.assign(new Event(type), { url: address, isMainFrame: true }));
    };

    commit("did-navigate", "https://example.test/one", { canGoBack: false, canGoForward: false });
    commit("did-navigate", "https://example.test/two", { canGoBack: true, canGoForward: false });
    commit("did-navigate", "https://example.test/one", { canGoBack: false, canGoForward: true });
    commit("did-navigate", "https://example.test/two", { canGoBack: true, canGoForward: false });
    commit("did-navigate-in-page", "https://example.test/two#section", { canGoBack: true, canGoForward: false });
    adapter.element.dispatchEvent(new Event("dom-ready"));

    expect(navigationStates).toEqual([
      { canGoBack: false, canGoForward: false },
      { canGoBack: true, canGoForward: false },
      { canGoBack: false, canGoForward: true },
      { canGoBack: true, canGoForward: false },
      { canGoBack: true, canGoForward: false },
      { canGoBack: true, canGoForward: false },
    ]);
    adapter.dispose();
  });

  it("retries the bounded guest discovery race after did-attach", async () => {
    const surfaceBridge = bridge();
    surfaceBridge.adopt
      .mockResolvedValueOnce({ ok: false, error: "guest-not-found" })
      .mockResolvedValueOnce({ ok: true });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 5, {
      root: document.body,
      bridge: surfaceBridge,
    });

    adapter.element.dispatchEvent(new Event("did-attach"));

    await vi.waitFor(() => expect(surfaceBridge.adopt).toHaveBeenCalledTimes(2));
    adapter.dispose();
  });

  it("forwards the main process navigation error code", async () => {
    const surfaceBridge = bridge();
    surfaceBridge.navigate.mockResolvedValue({
      ok: false,
      error: "navigation-failed",
      errorCode: "ERR_NAME_NOT_RESOLVED",
    });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 6, {
      root: document.body,
      bridge: surfaceBridge,
    });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    adapter.element.dispatchEvent(new Event("did-attach"));

    await vi.waitFor(() => expect(surfaceBridge.adopt).toHaveBeenCalledTimes(1));
    await adapter.navigate("https://missing.example.test/");

    expect(events).toContainEqual(expect.objectContaining({
      type: "load-failed",
      error: "navigation-failed",
      errorCode: "ERR_NAME_NOT_RESOLVED",
    }));
    adapter.dispose();
  });

  it("reports the next valid generation when preparation finds stale renderer state", async () => {
    const surfaceBridge = bridge();
    surfaceBridge.prepare.mockResolvedValue({
      ok: false,
      error: "stale-generation",
      nextGeneration: 12,
    });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, {
      root: document.body,
      bridge: surfaceBridge,
    });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    adapter.create();

    await vi.waitFor(() => expect(events).toContainEqual({
      type: "surface-lost",
      identity: IDENTITY,
      generation: 1,
      nextGeneration: 12,
    }));
    adapter.dispose();
  });
});
