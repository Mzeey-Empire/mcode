import { describe, expect, it, vi } from "vitest";
import type { Session, WebContents, Event as ElectronEvent } from "electron";
import * as NodeEvents from "node:events";

const fake = vi.hoisted(() => ({
  profile: {
    on: vi.fn<(name: string, handler: (event: ElectronEvent) => void) => void>(),
    webRequest: { onCompleted: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  },
  secondProfile: {
    on: vi.fn(),
    webRequest: { onCompleted: vi.fn() },
    setPermissionCheckHandler: vi.fn<Session["setPermissionCheckHandler"]>(),
    setPermissionRequestHandler: vi.fn<Session["setPermissionRequestHandler"]>(),
  },
  clipboardGuests: [1, 2].map((id) => ({
    id, mainFrame: {}, on: vi.fn(), once: vi.fn(), removeListener: vi.fn(),
    isDestroyed: () => false, getURL: () => `https://project-${id}.test/page`,
  })),
  guest: {
    setWindowOpenHandler: vi.fn<WebContents["setWindowOpenHandler"]>(),
    once: vi.fn<(name: string, listener: () => void) => void>(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
  },
  ipcMain: { on: vi.fn() },
}));
vi.mock("electron", () => ({
  ipcMain: fake.ipcMain,
  session: { fromPartition: (partition: string) => partition === "second" ? fake.secondProfile : fake.profile },
  webContents: { fromId: (id: number) => id > 1 ? fake.clipboardGuests[id - 2] : fake.guest },
}));

import { session, webContents } from "electron";
import { bindGuestPopup, installBrowserSessionPolicy } from "../electron-session-policy.js";
import { registerPreviewClipboardGuest } from "../clipboard-trust.js";
import { PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL } from "../../contracts/guest-input.js";

describe("workspace session policy", () => {
  const surface = {
    sourceSurface: {
      identity: {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        scope: { kind: "thread" as const, id: "thread" },
        tabId: "tab",
      },
      generation: 1,
    },
  };

  it("installs clipboard, download and failed-request policy once before first use", () => {
    const profile = session.fromPartition("persist:mcode-browser-22222222-2222-4222-8222-222222222222");
    installBrowserSessionPolicy(profile);
    installBrowserSessionPolicy(profile);
    expect(fake.profile.on).toHaveBeenCalledTimes(1);
    expect(fake.profile.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(fake.profile.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(fake.profile.webRequest.onCompleted).toHaveBeenCalledWith(
      { urls: ["http://*/*", "https://*/*"] }, expect.any(Function),
    );
    const downloadEvent = { preventDefault: vi.fn(), defaultPrevented: false };
    fake.profile.on.mock.calls[0]![1](downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("mediates non-default project popups and rejects unsafe and stale requests", () => {
    const emitPopup = vi.fn();
    let agent = false;
    const unbind = bindGuestPopup(webContents.fromId(1)!, {
      ...surface, emitPopup, isAgentOperationActive: () => agent,
    });
    const handler = fake.guest.setWindowOpenHandler.mock.calls[0]![0];
    const request = (url: string) => handler({
      url, frameName: "", features: "", disposition: "new-window",
      referrer: { url: "", policy: "no-referrer" },
    });
    for (const address of ["file:///tmp/x", "javascript:alert(1)", "data:text/html,hello", "custom:test", "https://user:pass@example.test", "not a url", `https://example.test/${"x".repeat(4096)}`]) {
      expect(request(address)).toEqual({ action: "deny" });
    }
    expect(emitPopup).not.toHaveBeenCalled();
    agent = true;
    expect(request("https://example.test/agent")).toEqual({ action: "deny" });
    expect(emitPopup).toHaveBeenCalledWith({ ...surface, address: "https://example.test/agent", initiator: "agent" });
    agent = false;
    expect(request("http://example.test/human")).toEqual({ action: "deny" });
    expect(emitPopup).toHaveBeenLastCalledWith({ ...surface, address: "http://example.test/human", initiator: "human" });
    emitPopup.mockImplementationOnce(() => { throw new Error("renderer unavailable"); });
    expect(request("https://example.test/delivery-failure")).toEqual({ action: "deny" });
    fake.guest.once.mock.calls[0]![1]();
    expect(request("https://example.test/stale")).toEqual({ action: "deny" });
    expect(emitPopup).toHaveBeenCalledTimes(3);
    unbind();
  });

  it("registers one IPC listener for two sessions and grants each guest one trusted write", () => {
    const ipc = new NodeEvents.EventEmitter();
    const first = session.fromPartition("second");
    const second = session.fromPartition("first");
    // Use fresh policy sessions so this assertion is independent of earlier installations.
    const firstCheck = vi.fn<Session["setPermissionCheckHandler"]>();
    const secondCheck = vi.fn<Session["setPermissionCheckHandler"]>();
    installBrowserSessionPolicy({ ...first, setPermissionCheckHandler: firstCheck }, ipc);
    installBrowserSessionPolicy({ ...second, setPermissionCheckHandler: secondCheck }, ipc);
    expect(ipc.listenerCount(PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL)).toBe(1);
    for (const [index, check] of [firstCheck, secondCheck].entries()) {
      const guest = webContents.fromId(index + 2);
      const handler = check.mock.calls[0]?.[0];
      if (!guest || !handler) throw new Error("Missing clipboard fixture");
      const dispose = registerPreviewClipboardGuest(guest, () => true);
      ipc.emit(PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL, { sender: guest, senderFrame: guest.mainFrame });
      const origin = index === 0 ? "https://project-1.test" : "https://project-2.test";
      const details = { isMainFrame: true, requestingUrl: `${origin}/page` };
      expect(handler(guest, "clipboard-sanitized-write", origin, details)).toBe(true);
      expect(handler(guest, "clipboard-sanitized-write", origin, details)).toBe(false);
      dispose();
    }
  });
});
