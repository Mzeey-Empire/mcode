import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { afterAll } from "vitest";
const profileRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-registry-profiles-"));
afterAll(() => NodeFS.rmSync(profileRoot, { recursive: true, force: true }));
import { resolvePreviewGuestPreloadPath } from "../../security/webview-attachment-policy.js";
import { BrowserWindow } from "electron";
import { browserProfiles } from "../../security/browser-profiles.js";

const ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};
const fakeGuests: FakeWebContents[] = [];
const createPartition = () => ({
  on: vi.fn(), webRequest: { onCompleted: vi.fn() },
  setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
  clearStorageData: vi.fn(async () => undefined), clearCache: vi.fn(async () => undefined),
});
const previewPartition = createPartition();
const otherPartition = createPartition();
const allWindows: FakeWindow[] = [];
const fixedPreload = resolvePreviewGuestPreloadPath(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
);

interface FakeWindow {
  id: number;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
}

interface FakeWebContents {
  close: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  url: string;
  title: string;
  hostWebContents: unknown;
  session: object;
  getType: () => string;
  getURL: () => string;
  getLastWebPreferences: () => { preload: string };
  isDestroyed: () => boolean;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  reloadIgnoringCache: ReturnType<typeof vi.fn>;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

function makeWindow(id: number): FakeWindow {
  return {
    id,
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

function makeGuest(
  host: FakeWindow,
  overrides: Partial<Pick<FakeWebContents, "getType" | "hostWebContents" | "session">> = {},
): FakeWebContents {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const guest: FakeWebContents = {
    close: vi.fn(() => { guest.destroyed = true; }),
    destroyed: false,
    url: "about:blank#token-1234",
    title: "Preview",
    hostWebContents: overrides.hostWebContents ?? host.webContents,
    session: overrides.session ?? previewPartition,
    getType: overrides.getType ?? (() => "webview"),
    getURL() { return this.url; },
    getLastWebPreferences() { return { preload: fixedPreload }; },
    isDestroyed() { return this.destroyed; },
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async (url: string) => { guest.url = url; }),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => true),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    once(event, listener) {
      const bag = listeners.get(event) ?? new Set();
      listeners.set(event, bag);
      bag.add(listener);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args); },
  };
  fakeGuests.push(guest);
  return guest;
}

vi.mock("electron", () => ({
  BrowserWindow: {
    fromId: vi.fn((id: number) => allWindows.find((window) => window.id === id) ?? null),
    fromWebContents: vi.fn((sender: unknown) => allWindows.find((window) => window.webContents === sender) ?? null),
  },
  app: { getPath: () => profileRoot },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers[channel] = handler; }),
  },
  session: {
    fromPartition: vi.fn((partition: string) => partition === "persist:mcode-browser-11111111-1111-4111-8111-111111111111" ? previewPartition : otherPartition),
  },
  webContents: {
    getAllWebContents: vi.fn(() => fakeGuests),
  },
}));

vi.mock("@mcode/shared", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../security/clipboard-trust.js", () => ({
  registerPreviewClipboardGuest: vi.fn(),
  unregisterPreviewClipboardGuest: vi.fn(),
  registerPreviewClipboardPermissionHandlers: vi.fn(),
}));

import {
  _resetAdoptionRegistryForTests,
  disposePreviewSurfacesForWorkspace,
  findPendingPreviewAttachment,
  findAdoptedWebContentsForWindow,
  registerPreviewSurfaceHandlers,
  requestRendererSurfaceDiscard,
} from "../registry.js";
import { getSession, previewTabScopeKey, sessions, toBrowserTabSet } from "../../state/window-session.js";

const surface = (generation = 1) => ({
  identity: {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    scope: { kind: "thread" as const, id: "thread-A" },
    tabId: "tab-1",
  },
  generation,
});

function invoke(channel: string, payload: unknown, sender = allWindows[0]!.webContents): unknown {
  return ipcHandlers[channel]!({ sender } as unknown, payload);
}

beforeEach(() => {
  fakeGuests.length = 0;
  allWindows.length = 0;
  allWindows.push(makeWindow(1));
  const session = getSession(allWindows[0] as never);
  session.workspaceId = "11111111-1111-4111-8111-111111111111";
  session.tabsByThread.clear();
  session.tabsByThread.set(previewTabScopeKey("11111111-1111-4111-8111-111111111111", "thread-A"), {
    threadId: "thread-A",
    activeTabId: "tab-1",
    tabs: [{ id: "tab-1", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
  });
  _resetAdoptionRegistryForTests();
  registerPreviewSurfaceHandlers();
});

afterEach(() => {
  _resetAdoptionRegistryForTests();
  sessions.clear();
});

describe("preview typed surface bridge", () => {
  it("returns typed failures when a pending workspace is removed during guest discovery", async () => {
    const workspaceId = "ABCDEFAB-1234-4234-8234-ABCDEFABCDEF";
    const win = BrowserWindow.fromId(1);
    if (!win) throw new Error("Missing fixture window");
    const state = getSession(win);
    state.workspaceId = workspaceId;
    state.tabsByThread.set(previewTabScopeKey(workspaceId, "thread-A"), {
      threadId: "thread-A", activeTabId: "tab-1",
      tabs: [{ id: "tab-1", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
    });
    const removedSurface = { ...surface(), identity: { ...surface().identity, workspaceId } };
    const payload = { surface: removedSurface, adoptionToken: "token-removed" };
    const guest = makeGuest(allWindows[0]!, { session: otherPartition });
    guest.url = "about:blank#token-removed";
    guest.close.mockImplementation(() => undefined);
    expect(invoke("preview.surface.prepare", payload)).toEqual({ ok: true });
    let removal = Promise.resolve();
    guest.getType = vi.fn(() => "webview").mockImplementationOnce(() => {
      removal = browserProfiles.remove(workspaceId);
      return "webview";
    });
    expect(invoke("preview.surface.adopt", payload)).toEqual({ ok: false, error: "guest-not-found" });
    await removal;
    expect(findPendingPreviewAttachment(1, "about:blank#token-removed")).toBeNull();
    expect(invoke("preview.surface.adopt", payload)).toEqual({ ok: false, error: "adoption-not-prepared" });
    expect(invoke("preview.surface.prepare", { ...payload, surface: { ...removedSurface, generation: 2 } }))
      .toEqual({ ok: false, error: "workspace-removed" });
  });

  it("closes an attached guest that has not yet been adopted when its workspace is removed", () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    disposePreviewSurfacesForWorkspace("11111111-1111-4111-8111-111111111111");
    expect(guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(findPendingPreviewAttachment(1, "about:blank#token-1234")).toBeNull();
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: false, error: "adoption-not-prepared" });
  });

  it("binds preparation and adoption to two distinct workspace sessions", () => {
    const win = allWindows[0]!;
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(findPendingPreviewAttachment(win.id, "about:blank#token-1234")).toEqual({
      surface: surface(), adoptionToken: "token-1234",
      partition: "persist:mcode-browser-11111111-1111-4111-8111-111111111111",
    });
    const guest = makeGuest(win, { session: otherPartition });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: false, error: "guest-not-found" });
    guest.session = previewPartition;
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });

    const second = makeWindow(2);
    allWindows.push(second);
    const state = getSession(BrowserWindow.fromId(second.id)!);
    state.workspaceId = "22222222-2222-4222-8222-222222222222";
    state.tabsByThread.set(previewTabScopeKey(state.workspaceId, "thread-A"), {
      threadId: "thread-A", activeTabId: "tab-1",
      tabs: [{ id: "tab-1", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
    });
    const otherSurface = { ...surface(), identity: { ...surface().identity, workspaceId: state.workspaceId } };
    const otherGuest = makeGuest(second, { session: otherPartition });
    otherGuest.url = "about:blank#token-5678";
    expect(invoke("preview.surface.prepare", { surface: otherSurface, adoptionToken: "token-5678" }, second.webContents)).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: otherSurface, adoptionToken: "token-5678" }, second.webContents)).toEqual({ ok: true });
    const popup = otherGuest.setWindowOpenHandler.mock.calls[0]![0];
    expect(popup({ url: "https://example.test/project-b" })).toEqual({ action: "deny" });
    expect(second.webContents.send).toHaveBeenCalledWith("preview.surface.popup-requested", {
      sourceSurface: otherSurface, address: "https://example.test/project-b", initiator: "human",
    });
    disposePreviewSurfacesForWorkspace("11111111-1111-4111-8111-111111111111");
    expect(guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(otherGuest.close).not.toHaveBeenCalled();
    expect(findAdoptedWebContentsForWindow(2, "thread-A", "tab-1", 1)).toBe(otherGuest);
  });

  it("releases the same workspace's surfaces in every window", () => {
    const guests: FakeWebContents[] = [];
    for (const id of [1, 2]) {
      const win = id === 1 ? allWindows[0]! : makeWindow(id);
      if (id === 2) allWindows.push(win);
      const state = getSession(BrowserWindow.fromId(win.id)!);
      state.workspaceId = "11111111-1111-4111-8111-111111111111";
      state.tabsByThread.set(previewTabScopeKey(state.workspaceId, "thread-A"), {
        threadId: "thread-A", activeTabId: "tab-1",
        tabs: [{ id: "tab-1", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
      });
      const adoptionToken = `window-${id}-token`;
      const guest = makeGuest(win);
      guest.url = `about:blank#${adoptionToken}`;
      guests.push(guest);
      expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken }, win.webContents)).toEqual({ ok: true });
      expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken }, win.webContents)).toEqual({ ok: true });
    }
    disposePreviewSurfacesForWorkspace("11111111-1111-4111-8111-111111111111");
    for (const id of [1, 2]) expect(findAdoptedWebContentsForWindow(id, "thread-A", "tab-1", 1)).toBeNull();
    for (const guest of guests) expect(guest.close).toHaveBeenCalledTimes(1);
  });

  it("requires prepare, adopts the unique inert owned guest, and resolves exact generation", () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 1)).toBe(guest);
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 2)).toBeNull();
    expect(toBrowserTabSet(getSession(allWindows[0] as never), "thread-A").tabs[0]?.warm).toBe(true);
  });

  it("rejects hostile sender, incomplete identity, mismatched owner, type, partition, and non-blank guests", () => {
    const hostile = makeWindow(2);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" }, hostile.webContents)).toMatchObject({ ok: false, error: "no-window" });
    expect(invoke("preview.surface.prepare", { surface: { generation: 1 }, adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "invalid-surface" });
    expect(invoke("preview.surface.prepare", { surface: { ...surface(), identity: { ...surface().identity, workspaceId: "22222222-2222-4222-8222-222222222222" } }, adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "surface-owner-mismatch" });
    expect(invoke("preview.surface.prepare", { surface: { ...surface(), identity: { ...surface().identity, scope: { kind: "thread", id: "thread-other" } } }, adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "surface-owner-mismatch" });
    for (const overrides of [
      { getType: () => "window" },
      { hostWebContents: hostile.webContents },
      { session: {} },
      { session: otherPartition },
    ]) {
      _resetAdoptionRegistryForTests();
      const guest = makeGuest(allWindows[0]!, overrides);
      expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
      expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toMatchObject({ ok: false });
      guest.url = "about:blank#token-1234";
    }
  });

  it("fails closed for stale, duplicate, non-unique, and post-blank adoption", () => {
    const guest = makeGuest(allWindows[0]!);
    guest.url = "about:blank";
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "guest-not-found" });
    guest.url = "about:blank#token-1234";
    expect(invoke("preview.surface.adopt", { surface: surface(2), adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "stale-generation" });
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "duplicate-adoption" });
    _resetAdoptionRegistryForTests();
    fakeGuests.length = 0;
    makeGuest(allWindows[0]!);
    makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "non-unique-adoption" });
  });

  it("returns the next valid generation when renderer state restarts after reload", () => {
    expect(invoke("preview.surface.prepare", { surface: surface(7), adoptionToken: "token-1234" })).toEqual({ ok: true });

    expect(invoke("preview.surface.prepare", { surface: surface(1), adoptionToken: "token-5678" })).toEqual({
      ok: false,
      error: "stale-generation",
      nextGeneration: 8,
    });
  });

  it("retires the adopted guest when the owner advances to a new generation", () => {
    const firstGuest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });

    firstGuest.url = "https://example.test";
    const secondGuest = makeGuest(allWindows[0]!);
    secondGuest.url = "about:blank#token-5678";
    expect(invoke("preview.surface.prepare", { surface: surface(2), adoptionToken: "token-5678" })).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 1)).toBeNull();
    expect(invoke("preview.surface.adopt", { surface: surface(2), adoptionToken: "token-5678" })).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 2)).toBe(secondGuest);

    const tabSet = getSession(allWindows[0] as never).tabsByThread.get(
      previewTabScopeKey("11111111-1111-4111-8111-111111111111", "thread-A"),
    )!;
    tabSet.tabs.push({ ...tabSet.tabs[0]!, id: "tab-2" });
    const otherSurface = { ...surface(), identity: { ...surface().identity, tabId: "tab-2" } };
    expect(invoke("preview.surface.prepare", { surface: otherSurface, adoptionToken: "token-5678" })).toMatchObject({ ok: false, error: "duplicate-adoption-token" });
  });

  it("releases the exact adopted generation after its tab ownership record is removed", () => {
    makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    getSession(allWindows[0] as never).tabsByThread.clear();

    expect(invoke("preview.surface.release", {
      surface: surface(),
      reason: "dispose",
    })).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 1)).toBeNull();
  });

  it("marks renderer residency cold on release and requests policy-selected discard by exact generation", () => {
    makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });

    expect(requestRendererSurfaceDiscard(allWindows[0] as never, "22222222-2222-4222-8222-222222222222", "thread-A", "tab-1")).toBe(false);
    expect(requestRendererSurfaceDiscard(allWindows[0] as never, "11111111-1111-4111-8111-111111111111", "thread-A", "tab-1")).toBe(true);
    expect(allWindows[0]!.webContents.send).toHaveBeenCalledWith(
      "preview.surface.discard-requested",
      surface(),
    );
    expect(invoke("preview.surface.release", {
      surface: surface(),
      reason: "attacker-controlled",
    })).toMatchObject({ ok: false, error: "invalid-release-reason" });

    expect(invoke("preview.surface.release", {
      surface: surface(),
      reason: "discard",
    })).toEqual({ ok: true });
    expect(toBrowserTabSet(getSession(allWindows[0] as never), "thread-A").tabs[0]?.warm).toBe(false);
    expect(allWindows[0]!.webContents.send).toHaveBeenCalledWith(
      "preview:tabs-updated",
      expect.objectContaining({
        tabs: [expect.objectContaining({ id: "tab-1", warm: false })],
      }),
    );
  });

  it("revalidates exact generation for address, history, reload, and force reload", async () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "initial", address: "https://example.test" } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "address", address: "file://attacker/share" } })).toMatchObject({ ok: false, error: "sensitive-file" });
    const localUrl = NodeURL.pathToFileURL(NodeURL.fileURLToPath(import.meta.url)).href;
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "restored", address: localUrl } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "back" } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "forward" } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "reload" } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "force-reload" } })).toEqual({ ok: true });
    expect(guest.loadURL).toHaveBeenCalledWith("https://example.test");
    expect(guest.loadURL).toHaveBeenCalledWith(localUrl);
    expect(guest.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(await invoke("preview.surface.navigate", { surface: surface(2), navigation: { kind: "reload" } })).toMatchObject({ ok: false, error: "stale-generation" });
  });

  it("rejects inherited navigation keys without dispatching them", async () => {
    makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });

    for (const kind of ["constructor", "toString", "__proto__"]) {
      await expect(invoke("preview.surface.navigate", { surface: surface(), navigation: { kind } })).resolves.toEqual({
        ok: false,
        error: "invalid-navigation",
      });
    }
  });

  it("accepts an aborted address load after the guest commits a new URL", async () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    guest.loadURL.mockImplementationOnce(async () => {
      guest.url = "https://example.test/final";
      throw Object.assign(new Error("ERR_ABORTED (-3)"), {
        code: "ERR_ABORTED",
        errno: -3,
      });
    });

    await expect(invoke("preview.surface.navigate", {
      surface: surface(),
      navigation: { kind: "address", address: "https://example.test/redirect" },
    })).resolves.toEqual({ ok: true });
  });

  it("preserves the Electron error code when an address load fails", async () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    guest.loadURL.mockRejectedValueOnce(Object.assign(new Error("ERR_NAME_NOT_RESOLVED (-105)"), {
      code: "ERR_NAME_NOT_RESOLVED",
      errno: -105,
    }));

    await expect(invoke("preview.surface.navigate", {
      surface: surface(),
      navigation: { kind: "address", address: "https://missing.example.test" },
    })).resolves.toEqual({
      ok: false,
      error: "navigation-failed",
      errorCode: "ERR_NAME_NOT_RESOLVED",
    });
  });
});
