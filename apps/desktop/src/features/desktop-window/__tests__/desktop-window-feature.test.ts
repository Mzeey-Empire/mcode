import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktopWindowFeatureTest = vi.hoisted(() => {
  type Listener = (...args: any[]) => unknown;
  type FakeWindow = {
    id: number;
    webContents: {
      on: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      getURL: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      openDevTools: ReturnType<typeof vi.fn>;
      getZoomLevel: ReturnType<typeof vi.fn>;
      setZoomLevel: ReturnType<typeof vi.fn>;
    };
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    setMenuBarVisibility: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    setBackgroundColor: ReturnType<typeof vi.fn>;
    options: { backgroundColor?: string };
    emit: (event: string, ...args: unknown[]) => void;
  };

  const windows: FakeWindow[] = [];
  const handlers = new Map<string, Listener>();
  const ipcListeners = new Map<string, Listener>();
  let nextWindowId = 1;

  const createWindow = (options: { backgroundColor?: string }): FakeWindow => {
    const listeners = new Map<string, Listener[]>();
    const addListener = (event: string, listener: Listener) => {
      const entries = listeners.get(event) ?? [];
      entries.push(listener);
      listeners.set(event, entries);
    };
    const webContents = {
      on: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
      once: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
      setWindowOpenHandler: vi.fn(),
      getURL: vi.fn(() => "http://localhost:5173/"),
      send: vi.fn(),
      openDevTools: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn(),
    };
    const window = {
      id: nextWindowId++,
      webContents,
      once: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
      on: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
      show: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      close: vi.fn(),
      setBackgroundColor: vi.fn(),
      options,
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
    };
    windows.push(window);
    return window;
  };

  class FakeBrowserWindow {
    static getAllWindows = vi.fn(() => windows);
    static getFocusedWindow = vi.fn(() => null);
    static fromWebContents = vi.fn(() => windows[0] ?? null);

    constructor(options: { backgroundColor?: string }) {
      return createWindow(options);
    }
  }

  const app = {
    isPackaged: false,
    getAppPath: vi.fn(() => "C:/mcode"),
    quit: vi.fn(),
  };
  const menu = {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
  };
  const shell = { openExternal: vi.fn(() => Promise.resolve()) };
  const nativeThemeListeners: Listener[] = [];
  const nativeTheme = {
    shouldUseDarkColors: true,
    on: vi.fn((event: string, listener: Listener) => {
      if (event === "updated") nativeThemeListeners.push(listener);
    }),
    emit: (event: string) => {
      if (event === "updated") for (const listener of nativeThemeListeners) listener();
    },
  };
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Listener) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, listener: Listener) => ipcListeners.set(channel, listener)),
  };

  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    menu,
    shell,
    nativeTheme,
    ipcMain,
    handlers,
    ipcListeners,
    windows,
    reset() {
      handlers.clear();
      ipcListeners.clear();
      windows.length = 0;
      nextWindowId = 1;
      nativeThemeListeners.length = 0;
      nativeTheme.shouldUseDarkColors = true;
      vi.clearAllMocks();
    },
  };
});

vi.mock("electron", () => ({
  app: desktopWindowFeatureTest.app,
  BrowserWindow: desktopWindowFeatureTest.BrowserWindow,
  Menu: desktopWindowFeatureTest.menu,
  shell: desktopWindowFeatureTest.shell,
  nativeTheme: desktopWindowFeatureTest.nativeTheme,
  ipcMain: desktopWindowFeatureTest.ipcMain,
  Notification: class { static isSupported = () => false; },
}));

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createDesktopWindowFeature } from "../index.js";

let themeHintPath = "";

function dependencies() {
  return {
    platform: "linux" as const,
    displayName: "Mcode",
    isDesktopDev: () => false,
    lifecycleHooks: {
      disposePreviewForWindow: vi.fn(),
      disposeBrowserAutomationForWindow: vi.fn(),
      hardenPreviewWebviewAttachment: vi.fn(),
      resolvePreviewGuestPreloadPath: vi.fn(() => "C:/mcode/preview-preload.cjs"),
      setupSpellcheck: vi.fn(),
      attachServerWindow: vi.fn(),
    },
    closeGuard: {
      getActiveAgentCount: vi.fn(async () => 0),
      showMessageBox: vi.fn(async () => ({ response: 1 })),
      quit: vi.fn(),
    },
    windowThemeHintPath: themeHintPath,
  };
}

describe("Desktop Window feature entry point", () => {
  beforeEach(() => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-window-theme-"));
    themeHintPath = NodePath.join(directory, "window-theme.json");
  });
  afterEach(() => {
    NodeFS.rmSync(NodePath.dirname(themeHintPath), { recursive: true, force: true });
  });

  it("registers native capabilities and recreates only when no window exists", () => {
    desktopWindowFeatureTest.reset();
    const deps = dependencies();
    const feature = createDesktopWindowFeature(deps);

    expect(desktopWindowFeatureTest.menu.setApplicationMenu).toHaveBeenCalledWith(null);
    expect(desktopWindowFeatureTest.handlers.has("window:perform")).toBe(true);
    expect(desktopWindowFeatureTest.handlers.has("notifications:show")).toBe(true);

    const firstWindow = feature.createWindow();
    const popupHandler = firstWindow.webContents.setWindowOpenHandler.mock.calls[0][0] as (
      details: { url: string },
    ) => { action: string };
    expect(popupHandler({ url: "https://example.com" })).toEqual({ action: "deny" });
    expect(desktopWindowFeatureTest.shell.openExternal).toHaveBeenCalledWith(
      "https://example.com/",
    );

    const notificationHandler = desktopWindowFeatureTest.handlers.get("notifications:show");
    expect(() => notificationHandler?.({ sender: {} }, { tag: "a", title: "Finished: a", body: "" }))
      .toThrow("Thread notifications require the main renderer");

    const actionHandler = desktopWindowFeatureTest.handlers.get("window:perform");
    actionHandler?.({ sender: {} }, "zoomReset");
    expect(firstWindow.webContents.setZoomLevel).toHaveBeenCalledWith(0);
    expect(deps.lifecycleHooks.setupSpellcheck).toHaveBeenCalledOnce();
    expect(deps.lifecycleHooks.attachServerWindow).toHaveBeenCalledOnce();

    expect(feature.recreateWindowIfNeeded()).toBeNull();
    desktopWindowFeatureTest.windows.length = 0;
    const recreatedWindow = feature.recreateWindowIfNeeded();
    expect(recreatedWindow).not.toBeNull();
    expect(deps.lifecycleHooks.setupSpellcheck).toHaveBeenCalledTimes(2);
    expect(deps.lifecycleHooks.attachServerWindow).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["light", true, "#fafcff"],
    ["dark", false, "#0c0d0f"],
    ["system", false, "#fafcff"],
    ["system", true, "#0c0d0f"],
  ])("opens the window for a %s preference (system dark: %s)", (theme, systemDark, background) => {
    desktopWindowFeatureTest.reset();
    desktopWindowFeatureTest.nativeTheme.shouldUseDarkColors = systemDark;
    NodeFS.writeFileSync(themeHintPath, JSON.stringify({ theme }));
    const window = createDesktopWindowFeature(dependencies()).createWindow();
    expect(window.options.backgroundColor).toBe(background);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "{not json"],
    ["not a theme", JSON.stringify({ theme: "sepia" })],
  ])("opens the window dark when the theme hint is %s", (_case, contents) => {
    desktopWindowFeatureTest.reset();
    desktopWindowFeatureTest.nativeTheme.shouldUseDarkColors = false;
    if (contents !== undefined) NodeFS.writeFileSync(themeHintPath, contents);
    const window = createDesktopWindowFeature(dependencies()).createWindow();
    expect(window.options.backgroundColor).toBe("#0c0d0f");
  });

  it("repaints and persists a theme reported by the main window only", async () => {
    desktopWindowFeatureTest.reset();
    const window = createDesktopWindowFeature(dependencies()).createWindow();
    const report = desktopWindowFeatureTest.ipcListeners.get("window:theme")!;

    report({ sender: {} }, "light");
    report({ sender: window.webContents }, "sepia");
    expect(window.setBackgroundColor).not.toHaveBeenCalled();

    report({ sender: window.webContents }, "light");
    expect(window.setBackgroundColor).toHaveBeenCalledWith("#fafcff");
    await vi.waitFor(() => {
      expect(JSON.parse(NodeFS.readFileSync(themeHintPath, "utf8"))).toEqual({ theme: "light" });
    });
  });

  it("re-creates the window in the latest reported theme before its hint is written", () => {
    desktopWindowFeatureTest.reset();
    const feature = createDesktopWindowFeature(dependencies());
    const window = feature.createWindow();
    desktopWindowFeatureTest.ipcListeners.get("window:theme")!({ sender: window.webContents }, "light");
    window.emit("closed");

    expect(feature.createWindow().options.backgroundColor).toBe("#fafcff");
  });

  it("follows the system appearance only in system mode", () => {
    desktopWindowFeatureTest.reset();
    desktopWindowFeatureTest.nativeTheme.shouldUseDarkColors = true;
    const window = createDesktopWindowFeature(dependencies()).createWindow();
    const report = desktopWindowFeatureTest.ipcListeners.get("window:theme")!;

    report({ sender: window.webContents }, "system");
    desktopWindowFeatureTest.nativeTheme.shouldUseDarkColors = false;
    desktopWindowFeatureTest.nativeTheme.emit("updated");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#fafcff");

    report({ sender: window.webContents }, "dark");
    desktopWindowFeatureTest.nativeTheme.emit("updated");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#0c0d0f");
  });

  it("forgets the main window once it closes", () => {
    desktopWindowFeatureTest.reset();
    const feature = createDesktopWindowFeature(dependencies());
    const window = feature.createWindow();
    expect(feature.getMainWindow()).toBe(window);

    window.emit("closed");

    expect(feature.getMainWindow()).toBeNull();
  });
});
