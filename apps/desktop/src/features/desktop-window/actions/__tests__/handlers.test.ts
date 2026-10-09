import { beforeEach, describe, expect, it, vi } from "vitest";

const handlersTest = vi.hoisted(() => {
  type Handler = (...args: any[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  };
  const browserWindowFromWebContents = vi.fn();
  return { handlers, ipcMain, browserWindowFromWebContents };
});

vi.mock("electron", () => ({
  ipcMain: handlersTest.ipcMain,
  BrowserWindow: { fromWebContents: handlersTest.browserWindowFromWebContents },
}));

import { registerDesktopWindowActionHandler } from "../handlers.js";

describe("Desktop Window action IPC handler", () => {
  beforeEach(() => {
    handlersTest.handlers.clear();
    handlersTest.browserWindowFromWebContents.mockReset();
    registerDesktopWindowActionHandler();
  });

  it("authorizes the sender window and dispatches an allowed action", () => {
    let fullScreen = false;
    const window = {
      isDestroyed: vi.fn(() => false),
      isFullScreen: vi.fn(() => fullScreen),
      setFullScreen: vi.fn((value: boolean) => {
        fullScreen = value;
      }),
    };
    handlersTest.browserWindowFromWebContents.mockReturnValue(window);

    const handler = handlersTest.handlers.get("window:perform")!;
    handler({ sender: { id: 1 } }, "toggleFullScreen");

    expect(handlersTest.browserWindowFromWebContents).toHaveBeenCalledWith({ id: 1 });
    expect(window.setFullScreen).toHaveBeenCalledWith(true);
  });

  // The allowlist test in window-actions.test.ts pins the six accepted names, so
  // any other name, including the retired close and edit actions, lands here.
  it.each(["execute arbitrary code", "close", "edit", ""])("rejects %j before resolving a sender window", (action) => {
    const handler = handlersTest.handlers.get("window:perform")!;

    expect(() => handler({ sender: {} }, action)).toThrow("Invalid desktop window action");
    expect(handlersTest.browserWindowFromWebContents).not.toHaveBeenCalled();
  });

  it("ignores unauthorized and destroyed sender windows", () => {
    const handler = handlersTest.handlers.get("window:perform")!;
    const destroyed = {
      isDestroyed: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      setFullScreen: vi.fn(),
    };
    handlersTest.browserWindowFromWebContents
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(destroyed);

    handler({ sender: { id: 1 } }, "toggleFullScreen");
    handler({ sender: { id: 2 } }, "toggleFullScreen");

    expect(destroyed.setFullScreen).not.toHaveBeenCalled();
  });
});
