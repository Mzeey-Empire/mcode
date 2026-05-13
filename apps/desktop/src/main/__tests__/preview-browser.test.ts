import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Electron mocks
// ---------------------------------------------------------------------------

/** Tracks all registered ipcMain.handle handlers by channel name. */
let ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};

/** Tracks all registered ipcMain.on handlers by channel name. */
let ipcOnHandlers: Record<string, (...args: unknown[]) => unknown> = {};

/** Tracks BrowserView instances created during a test. */
let createdViews: ReturnType<typeof makeBrowserView>[] = [];

function makeBrowserView() {
  const webContents = {
    isDestroyed: vi.fn().mockReturnValue(false),
    getURL: vi.fn().mockReturnValue("https://example.com"),
    getTitle: vi.fn().mockReturnValue("Example"),
    loadURL: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    canGoBack: vi.fn().mockReturnValue(false),
    canGoForward: vi.fn().mockReturnValue(false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue("css-key"),
    removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
  };
  const view = {
    webContents,
    setBounds: vi.fn(),
  };
  createdViews.push(view);
  return view;
}

/** Auto-incrementing window ID so each test gets a fresh session in the module-level sessions Map. */
let nextWindowId = 1;

/** Minimal BrowserWindow stub. */
function makeWindow() {
  const id = nextWindowId++;
  let currentView: ReturnType<typeof makeBrowserView> | null = null;
  return {
    id,
    isDestroyed: vi.fn().mockReturnValue(false),
    getBrowserView: vi.fn(() => currentView),
    setBrowserView: vi.fn((v: ReturnType<typeof makeBrowserView>) => {
      currentView = v;
    }),
    removeBrowserView: vi.fn((v: ReturnType<typeof makeBrowserView>) => {
      if (currentView === v) currentView = null;
    }),
    webContents: {
      isDestroyed: vi.fn().mockReturnValue(false),
      send: vi.fn(),
    },
  };
}

vi.mock("electron", () => ({
  BrowserView: vi.fn(function () {
    const view = makeBrowserView();
    return view;
  }),
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers[channel] = handler;
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcOnHandlers[channel] = handler;
    }),
  },
  session: {
    fromPartition: vi.fn(() => ({
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onCompleted: vi.fn(),
      },
    })),
  },
  shell: {
    openExternal: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("@mcode/contracts", () => ({
  clampMcodeBrowserCaptureV2: vi.fn(),
  isBrowserCaptureSpillAppDataPath: vi.fn().mockReturnValue(false),
  MCODE_BROWSER_CAPTURE_V2_STRING_MAX: 100_000,
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
  redactMcodeBrowserCaptureV2: vi.fn(),
  spillWorkspaceDirSegment: vi.fn().mockReturnValue("ws"),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

import { BrowserWindow } from "electron";
import { registerPreviewBrowserHandlers, disposePreviewForWindow } from "../preview/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate an IPC event from a window. */
function fakeEvent(win: ReturnType<typeof makeWindow>) {
  (BrowserWindow.fromWebContents as ReturnType<typeof vi.fn>).mockReturnValue(win);
  return { sender: win.webContents } as unknown;
}

const VALID_BOUNDS = { x: 100, y: 100, width: 800, height: 600 };

/** Show the preview for a given thread. */
async function showPreview(
  win: ReturnType<typeof makeWindow>,
  opts?: { threadId?: string; url?: string },
) {
  const ev = fakeEvent(win);
  await ipcHandlers["preview:sync"]!(ev, {
    visible: true,
    bounds: VALID_BOUNDS,
    threadId: opts?.threadId ?? "thread-1",
    resumeUrlHint: opts?.url ?? "https://example.com",
    workspaceId: "ws-1",
  });
}

/** Hide the preview: calls preview:sync with visible=false. */
async function hidePreview(
  win: ReturnType<typeof makeWindow>,
  opts?: { threadId?: string },
) {
  const ev = fakeEvent(win);
  await ipcHandlers["preview:sync"]!(ev, {
    visible: false,
    bounds: null,
    threadId: opts?.threadId ?? "thread-1",
    workspaceId: "ws-1",
  });
}

// ---------------------------------------------------------------------------
// Setup - registerPreviewBrowserHandlers is called once (module-level ipcMain
// handlers can only be registered once). Each test uses a unique window ID so
// it gets a fresh PreviewSession from the module-level sessions Map.
// ---------------------------------------------------------------------------

let handlersRegistered = false;

beforeEach(() => {
  createdViews = [];
  if (!handlersRegistered) {
    registerPreviewBrowserHandlers();
    handlersRegistered = true;
  }
});

/** Track windows created per test so we can dispose their sessions afterward. */
let testWindows: ReturnType<typeof makeWindow>[] = [];

afterEach(() => {
  for (const win of testWindows) {
    disposePreviewForWindow(win as never);
  }
  testWindows = [];
});

/** Create a window and register it for cleanup. */
function createWindow() {
  const win = makeWindow();
  testWindows.push(win);
  return win;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preview-browser", () => {
  describe("hidePreview (tab switch)", () => {
    it("detaches the BrowserView from the window without destroying webContents", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      expect(win.setBrowserView).toHaveBeenCalledWith(view);

      await hidePreview(win);

      expect(win.removeBrowserView).toHaveBeenCalledWith(view);
      expect(view.webContents.close).not.toHaveBeenCalled();
    });

    it("sends loading-state false when hiding", async () => {
      const win = createWindow();
      await showPreview(win);
      win.webContents.send.mockClear();

      await hidePreview(win);

      expect(win.webContents.send).toHaveBeenCalledWith(
        "preview:loading-state",
        { loading: false },
      );
    });
  });

  describe("re-show after hide", () => {
    it("reattaches the same BrowserView without creating a new one", async () => {
      const win = createWindow();
      await showPreview(win);
      const viewCountAfterFirstShow = createdViews.length;

      await hidePreview(win);
      await showPreview(win);

      expect(createdViews.length).toBe(viewCountAfterFirstShow);
    });

    it("does not reload the page when re-showing the same thread", async () => {
      const win = createWindow();
      await showPreview(win, { url: "https://example.com" });

      const view = createdViews[0]!;
      view.webContents.loadURL.mockClear();
      view.webContents.getURL.mockReturnValue("https://example.com");

      await hidePreview(win);
      await showPreview(win, { url: "https://example.com" });

      expect(view.webContents.loadURL).not.toHaveBeenCalled();
    });

    it("preserves navigation history across hide/show cycle", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      view.webContents.canGoBack.mockReturnValue(true);
      view.webContents.canGoForward.mockReturnValue(false);
      view.webContents.getURL.mockReturnValue("https://example.com/page2");

      await hidePreview(win);
      await showPreview(win);

      const ev = fakeEvent(win);
      const state = await ipcHandlers["preview:get-navigation-state"]!(ev);
      expect(state).toEqual({ canGoBack: true, canGoForward: false });
    });
  });

  describe("thread switch", () => {
    it("loads the new thread URL when switching threads", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-1", url: "https://one.com" });

      const view = createdViews[0]!;
      view.webContents.loadURL.mockClear();
      view.webContents.getURL.mockReturnValue("https://one.com");

      await showPreview(win, { threadId: "thread-2", url: "https://two.com" });

      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://two.com");
    });
  });

  describe("disposePreviewForWindow (full teardown)", () => {
    it("destroys webContents when the window is closing", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      win.removeBrowserView.mockClear();

      disposePreviewForWindow(win as never);
      // Remove from testWindows so afterEach doesn't double-dispose.
      testWindows = testWindows.filter((w) => w !== win);

      expect(win.removeBrowserView).toHaveBeenCalled();
      expect(view.webContents.close).toHaveBeenCalled();
    });
  });

  describe("navigation controls", () => {
    it("go-back calls webContents.goBack when history exists", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      view.webContents.canGoBack.mockReturnValue(true);

      const ev = fakeEvent(win);
      const result = await ipcHandlers["preview:go-back"]!(ev);

      expect(result).toBe(true);
      expect(view.webContents.goBack).toHaveBeenCalled();
    });

    it("go-back returns false when no history", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      view.webContents.canGoBack.mockReturnValue(false);

      const ev = fakeEvent(win);
      const result = await ipcHandlers["preview:go-back"]!(ev);

      expect(result).toBe(false);
      expect(view.webContents.goBack).not.toHaveBeenCalled();
    });

    it("go-forward calls webContents.goForward when history exists", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      view.webContents.canGoForward.mockReturnValue(true);

      const ev = fakeEvent(win);
      const result = await ipcHandlers["preview:go-forward"]!(ev);

      expect(result).toBe(true);
      expect(view.webContents.goForward).toHaveBeenCalled();
    });
  });

  describe("local file preview", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "preview-test-"));
      writeFileSync(join(tempDir, "index.html"), "<h1>Hello</h1>");
      writeFileSync(join(tempDir, "doc.pdf"), "%PDF-fake");
      mkdirSync(join(tempDir, "sub"));
      writeFileSync(join(tempDir, "sub", "page.html"), "<p>Sub</p>");
      writeFileSync(join(tempDir, ".env"), "SECRET=123");
      mkdirSync(join(tempDir, "hasindex"));
      writeFileSync(join(tempDir, "hasindex", "index.html"), "<p>Index</p>");
    });

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    /** Navigate via the preview:navigate handler. */
    async function navigate(
      win: ReturnType<typeof makeWindow>,
      url: string,
      workspacePath?: string | null,
    ) {
      const ev = fakeEvent(win);
      return ipcHandlers["preview:navigate"]!(ev, url, workspacePath ?? null) as Promise<
        { ok: true } | { ok: false; error: string }
      >;
    }

    it("navigates to an absolute file path", async () => {
      const win = createWindow();
      await showPreview(win);

      const filePath = join(tempDir, "index.html");
      const result = await navigate(win, filePath);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(filePath).href,
      );
    });

    it("navigates to a relative file path resolved against workspace", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "sub/page.html", tempDir);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(tempDir, "sub", "page.html")).href,
      );
    });

    it("returns error for relative path without workspace", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "sub/page.html", null);

      expect(result).toEqual({ ok: false, error: "no-workspace" });
    });

    it("returns file-not-found for nonexistent file", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, join(tempDir, "nope.html"));

      expect(result).toEqual({ ok: false, error: "file-not-found" });
    });

    it("blocks sensitive files (.env)", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, join(tempDir, ".env"));

      expect(result).toEqual({ ok: false, error: "sensitive-file" });
    });

    it("resolves directory with index.html", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, join(tempDir, "hasindex"));

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(tempDir, "hasindex", "index.html")).href,
      );
    });

    it("returns is-directory for directory without index.html", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, join(tempDir, "sub"));

      expect(result).toEqual({ ok: false, error: "is-directory" });
    });

    it("still navigates to http URLs normally", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "https://example.com");

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("still prepends https:// to bare domains", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "example.com");

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("navigates to file with browser-viewable extension", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "./doc.pdf", tempDir);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(tempDir, "doc.pdf")).href,
      );
    });

    it("blocks explicit file:// URL pointing to a sensitive file", async () => {
      const win = createWindow();
      await showPreview(win);

      const envUrl = pathToFileURL(join(tempDir, ".env")).href;
      const result = await navigate(win, envUrl);

      expect(result).toEqual({ ok: false, error: "sensitive-file" });
    });

    it("allows explicit file:// URL pointing to a safe file", async () => {
      const win = createWindow();
      await showPreview(win);

      const htmlUrl = pathToFileURL(join(tempDir, "index.html")).href;
      const result = await navigate(win, htmlUrl);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(htmlUrl);
    });

    it("follows symlink to directory and returns index.html", async () => {
      // Create a symlink to the "hasindex" directory.
      const linkPath = join(tempDir, "link-to-dir");
      try {
        symlinkSync(join(tempDir, "hasindex"), linkPath, "junction");
      } catch {
        // Symlink creation may require elevated privileges on Windows; skip.
        return;
      }

      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, linkPath);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      // Should resolve through the symlink target directory's index.html.
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(tempDir, "hasindex", "index.html")).href,
      );
    });

    it("blocks hosted file:// URLs with a non-local hostname", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "file://evil-host/C:/Windows/not-real.ini");

      expect(result).toEqual({ ok: false, error: "sensitive-file" });
    });

    it("blocks UNC paths when entered as a Windows share path", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "\\\\fake-server\\share\\page.html");

      expect(result).toEqual({ ok: false, error: "sensitive-file" });
    });

    it("resolves directory index when index.html is a symlink to a file", async () => {
      const dirWithSymlinkIndex = join(tempDir, "symlink-index-dir");
      mkdirSync(dirWithSymlinkIndex);
      try {
        symlinkSync(join(tempDir, "hasindex", "index.html"), join(dirWithSymlinkIndex, "index.html"));
      } catch {
        return;
      }

      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, dirWithSymlinkIndex);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(dirWithSymlinkIndex, "index.html")).href,
      );
    });

    it("treats domain-like input with file extension as URL, not file path", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "example.com/page.html");

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com/page.html");
    });
  });
});
