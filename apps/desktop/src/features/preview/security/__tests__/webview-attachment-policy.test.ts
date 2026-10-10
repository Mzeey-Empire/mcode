import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sender = { send: vi.fn(), isDestroyed: () => false };
  return {
    handlers, sender,
    window: { id: 1, webContents: sender, isDestroyed: () => false },
    profile: {
      on: vi.fn(), webRequest: { onCompleted: vi.fn() },
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    },
  };
});
vi.mock("electron", () => ({
  app: { getPath: () => root },
  BrowserWindow: { fromWebContents: () => fake.window },
  webContents: { fromId: () => fake.sender },
  session: { fromPartition: () => fake.profile },
  ipcMain: {
    on: vi.fn(),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => fake.handlers.set(channel, handler),
  },
}));

import { BrowserWindow, webContents } from "electron";
import { getSession, previewTabScopeKey } from "../../state/window-session.js";
import { _resetAdoptionRegistryForTests, registerPreviewSurfaceHandlers } from "../../surfaces/registry.js";
import { hardenPreviewWebviewAttachment, resolvePreviewGuestPreloadPath } from "../webview-attachment-policy.js";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-attachment-profiles-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const A = "11111111-1111-4111-8111-111111111111";
const partition = "persist:mcode-browser-11111111-1111-4111-8111-111111111111";
const fixed = resolvePreviewGuestPreloadPath("C:/mcode/dist/main");

beforeEach(() => {
  _resetAdoptionRegistryForTests();
  registerPreviewSurfaceHandlers();
  const state = getSession(BrowserWindow.fromWebContents(webContents.fromId(1)!)!);
  state.workspaceId = A;
  state.tabsByThread.set(previewTabScopeKey(A, "thread"), {
    threadId: "thread", activeTabId: "tab",
    tabs: [{ id: "tab", threadId: "thread", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
  });
  expect(fake.handlers.get("preview.surface.prepare")!({ sender: fake.sender }, {
    surface: { identity: { workspaceId: A, scope: { kind: "thread", id: "thread" }, tabId: "tab" }, generation: 1 },
    adoptionToken: "token-1234",
  })).toEqual({ ok: true });
});

describe("preview webview security", () => {
  it("keeps the prepared partition and installs policy before accepting the first guest", () => {
    const preferences = {
      nodeIntegration: true, contextIsolation: false, sandbox: false, devTools: false,
      preload: "C:/attacker/preload.js", preloadURL: "file:///attacker/preload.js",
    };
    const params = { src: "about:blank#token-1234", partition, preload: "C:/attacker/preload.js" };
    expect(hardenPreviewWebviewAttachment(preferences, params, fixed, 1)).toBe(true);
    expect(preferences).toEqual({
      nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: true, preload: fixed,
    });
    expect(params).toEqual({ src: "about:blank#token-1234", partition, preload: fixed });
    expect(fake.profile.on).toHaveBeenCalledWith("will-download", expect.any(Function));
    expect(fake.profile.webRequest.onCompleted).toHaveBeenCalledWith({ urls: ["http://*/*", "https://*/*"] }, expect.any(Function));
    expect(fake.profile.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(fixed.replaceAll("\\", "/")).toBe("C:/mcode/dist/preload/preview-guest-preload.cjs");
  });

  it.each([
    { src: "about:blank#token-1234", partition: "persist:mcode-browser-22222222-2222-4222-8222-222222222222" },
    { src: "about:blank#token-1234", partition: "persist:mcode-browser-../escape" },
    { src: "about:blank", partition },
    { src: "about:blank#unprepared", partition },
    { partition },
  ])("refuses an unprepared token or foreign partition: %o", (params) => {
    const requested = { ...params };
    expect(hardenPreviewWebviewAttachment({}, params, fixed, 1)).toBe(false);
    expect(params).toEqual(requested);
  });

  it("refuses this window's token in another window", () => {
    expect(hardenPreviewWebviewAttachment({}, { src: "about:blank#token-1234", partition }, fixed, 2)).toBe(false);
  });
});
