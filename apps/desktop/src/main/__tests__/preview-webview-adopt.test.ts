import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Tracks ipc handlers registered via the mocked electron module so tests can
 * call them directly without spinning up an actual Electron runtime.
 */
const ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};

interface FakeWebContents {
  id: number;
  destroyed: boolean;
  url: string;
  title: string;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  isDestroyed: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  once: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string) => void;
}

function makeFakeWebContents(id: number): FakeWebContents {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    id,
    destroyed: false,
    url: `https://t.test/${id}`,
    title: `Tab ${id}`,
    listeners,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return this.url;
    },
    getTitle() {
      return this.title;
    },
    once(event, cb) {
      let bag = listeners.get(event);
      if (!bag) {
        bag = new Set();
        listeners.set(event, bag);
      }
      const wrapper = (...args: unknown[]) => {
        bag!.delete(wrapper);
        cb(...args);
      };
      bag.add(wrapper);
    },
    removeListener(event, cb) {
      const bag = listeners.get(event);
      if (!bag) return;
      // Real Electron matches by reference; our once-wrapper means callers
      // typically remove by passing the same wrapper they got. For the test
      // it's enough to clear all listeners on that event.
      for (const w of bag) {
        if (w === cb) bag.delete(w);
      }
    },
    emit(event) {
      const bag = listeners.get(event);
      if (!bag) return;
      for (const cb of [...bag]) cb();
    },
  };
}

const fakeWebContentsRegistry = new Map<number, FakeWebContents>();

function makeWindow(id: number) {
  return {
    id,
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

const allWindows: Array<ReturnType<typeof makeWindow>> = [];

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => allWindows[0]),
    getAllWindows: vi.fn(() => allWindows),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers[channel] = handler;
    }),
  },
  webContents: {
    fromId: vi.fn((id: number) => fakeWebContentsRegistry.get(id) ?? null),
  },
}));

vi.mock("@mcode/shared", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  _resetAdoptionRegistryForTests,
  findAdoptedWebContents,
  registerWebviewAdoptHandlers,
} from "../preview/preview-webview-adopt.js";

beforeEach(() => {
  fakeWebContentsRegistry.clear();
  allWindows.length = 0;
  allWindows.push(makeWindow(1));
  _resetAdoptionRegistryForTests();
});

afterEach(() => {
  _resetAdoptionRegistryForTests();
});

describe("preview-webview-adopt", () => {
  let registered = false;
  beforeEach(() => {
    if (!registered) {
      registerWebviewAdoptHandlers();
      registered = true;
    }
  });

  function fakeEvent() {
    return { sender: allWindows[0]!.webContents } as unknown;
  }

  it("registers a WebContents under (threadId, tabId) and locates it", () => {
    const wc = makeFakeWebContents(42);
    fakeWebContentsRegistry.set(42, wc);

    const result = ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 42,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(result).toEqual({ ok: true });

    const located = findAdoptedWebContents("thread-A", "tab-1");
    expect(located).toBe(wc);
  });

  it("rejects invalid webContentsId / threadId / tabId", () => {
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: 0,
        threadId: "t",
        tabId: "x",
      }),
    ).toMatchObject({ ok: false });
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: 1,
        threadId: "",
        tabId: "x",
      }),
    ).toMatchObject({ ok: false });
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: 1,
        threadId: "t",
        tabId: "",
      }),
    ).toMatchObject({ ok: false });
  });

  it("returns webcontents-not-found when fromId returns nothing", () => {
    const result = ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 999,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(result).toMatchObject({ ok: false, error: "webcontents-not-found" });
  });

  it("drops the registration when the adopted WebContents emits 'destroyed'", () => {
    const wc = makeFakeWebContents(7);
    fakeWebContentsRegistry.set(7, wc);

    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 7,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(findAdoptedWebContents("thread-A", "tab-1")).toBe(wc);

    wc.destroyed = true;
    wc.emit("destroyed");
    expect(findAdoptedWebContents("thread-A", "tab-1")).toBeNull();
  });

  it("preview:release-webview drops the slot", () => {
    const wc = makeFakeWebContents(11);
    fakeWebContentsRegistry.set(11, wc);
    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 11,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(findAdoptedWebContents("thread-A", "tab-1")).toBe(wc);

    const released = ipcHandlers["preview:release-webview"]!(fakeEvent(), {
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(released).toEqual({ ok: true });
    expect(findAdoptedWebContents("thread-A", "tab-1")).toBeNull();
  });

  it("re-adopting the same slot replaces the prior registration", () => {
    const wc1 = makeFakeWebContents(20);
    const wc2 = makeFakeWebContents(21);
    fakeWebContentsRegistry.set(20, wc1);
    fakeWebContentsRegistry.set(21, wc2);

    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 20,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 21,
      threadId: "thread-A",
      tabId: "tab-1",
    });

    expect(findAdoptedWebContents("thread-A", "tab-1")).toBe(wc2);
  });
});
