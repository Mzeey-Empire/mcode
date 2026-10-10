import { describe, expect, it, vi } from "vitest";
import type { WebContents, Event as ElectronEvent } from "electron";

const fake = vi.hoisted(() => ({
  profile: {
    on: vi.fn<(name: string, handler: (event: ElectronEvent) => void) => void>(),
    webRequest: { onCompleted: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  },
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
  session: { fromPartition: () => fake.profile },
  webContents: { fromId: () => fake.guest },
}));

import { session, webContents } from "electron";
import { bindGuestPopup, installBrowserSessionPolicy } from "../electron-session-policy.js";

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
});
