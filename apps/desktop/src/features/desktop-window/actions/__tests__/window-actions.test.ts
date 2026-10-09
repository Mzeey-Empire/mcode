import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

import {
  DESKTOP_WINDOW_ACTIONS,
  performDesktopWindowAction,
} from "../window-actions.js";

function createWindow() {
  let fullScreen = false;
  let devToolsOpen = false;
  const webContents = {
    getZoomLevel: vi.fn(() => 1),
    setZoomLevel: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    isDevToolsOpened: vi.fn(() => devToolsOpen),
    closeDevTools: vi.fn(() => {
      devToolsOpen = false;
    }),
    openDevTools: vi.fn(() => {
      devToolsOpen = true;
    }),
  };
  const window = {
    webContents,
    isFullScreen: vi.fn(() => fullScreen),
    setFullScreen: vi.fn((value: boolean) => {
      fullScreen = value;
    }),
  };
  return { window, webContents };
}

describe("Desktop Window native actions", () => {
  beforeEach(() => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows only window actions, leaving edit commands to Chromium", () => {
    expect([...DESKTOP_WINDOW_ACTIONS]).toEqual([
      "zoomIn",
      "zoomOut",
      "zoomReset",
      "toggleFullScreen",
      "reload",
      "toggleDevTools",
    ]);
  });

  it("changes zoom by one half level and resets it", () => {
    const fixture = createWindow();

    performDesktopWindowAction(fixture.window as never, "zoomIn");
    performDesktopWindowAction(fixture.window as never, "zoomOut");
    performDesktopWindowAction(fixture.window as never, "zoomReset");

    expect(fixture.webContents.setZoomLevel).toHaveBeenNthCalledWith(1, 1.5);
    expect(fixture.webContents.setZoomLevel).toHaveBeenNthCalledWith(2, 0.5);
    expect(fixture.webContents.setZoomLevel).toHaveBeenNthCalledWith(3, 0);
  });

  it("toggles fullscreen", () => {
    const fixture = createWindow();

    performDesktopWindowAction(fixture.window as never, "toggleFullScreen");

    expect(fixture.window.setFullScreen).toHaveBeenCalledWith(true);
  });

  it("allows reload and DevTools only in desktop development", () => {
    const fixture = createWindow();
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");

    performDesktopWindowAction(fixture.window as never, "reload");
    performDesktopWindowAction(fixture.window as never, "toggleDevTools");
    performDesktopWindowAction(fixture.window as never, "toggleDevTools");

    expect(fixture.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(fixture.webContents.openDevTools).toHaveBeenCalledWith({ mode: "right" });
    expect(fixture.webContents.closeDevTools).toHaveBeenCalledOnce();
  });

  it("does not reload or open DevTools outside desktop development", () => {
    const fixture = createWindow();

    performDesktopWindowAction(fixture.window as never, "reload");
    performDesktopWindowAction(fixture.window as never, "toggleDevTools");

    expect(fixture.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(fixture.webContents.openDevTools).not.toHaveBeenCalled();
  });
});
