import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture writes to autoUpdater so we can assert on the channel + prerelease config.
// Hoisted so the reference is initialized before vi.mock's hoisted factory runs.
const { updaterMock } = vi.hoisted(() => ({
  updaterMock: {
    channel: "",
    allowPrerelease: false,
    allowDowngrade: false,
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: updaterMock,
}));

vi.mock("electron", () => ({
  app: {
    getVersion: vi.fn().mockReturnValue("0.1.0-test"),
    isPackaged: false,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]), getFocusedWindow: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn().mockReturnValue(false) }),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
}));

import { applyChannelConfig } from "../auto-updater";

describe("applyChannelConfig", () => {
  beforeEach(() => {
    updaterMock.channel = "";
    updaterMock.allowPrerelease = false;
    updaterMock.allowDowngrade = false;
  });

  it("nightly: channel=nightly, allowPrerelease=true", () => {
    applyChannelConfig("nightly");
    expect(updaterMock.channel).toBe("nightly");
    expect(updaterMock.allowPrerelease).toBe(true);
  });

  it("stable: channel=latest, allowPrerelease=false", () => {
    applyChannelConfig("stable");
    expect(updaterMock.channel).toBe("latest");
    expect(updaterMock.allowPrerelease).toBe(false);
  });

  it("does not touch allowDowngrade by default", () => {
    applyChannelConfig("nightly");
    expect(updaterMock.allowDowngrade).toBe(false);
    applyChannelConfig("stable");
    expect(updaterMock.allowDowngrade).toBe(false);
  });
});
