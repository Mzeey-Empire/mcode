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

import { applyChannelConfig, isCrossChannelDowngrade } from "../auto-updater";

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

describe("isCrossChannelDowngrade", () => {
  it("nightly version > latest stable triggers downgrade flow", () => {
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.11.1",
      }),
    ).toBe(true);
  });

  it("nightly version older than latest stable does not", () => {
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.11.0-nightly.20260301.1",
        latestStable: "0.11.1",
      }),
    ).toBe(false);
  });

  it("stable → nightly never triggers downgrade", () => {
    expect(
      isCrossChannelDowngrade({
        from: "stable",
        to: "nightly",
        currentVersion: "0.11.1",
        latestStable: "0.11.1",
      }),
    ).toBe(false);
  });

  it("same channel never triggers downgrade", () => {
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "nightly",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.11.1",
      }),
    ).toBe(false);
  });

  it("missing latestStable falls back to false (no info, no warning)", () => {
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: undefined,
      }),
    ).toBe(false);
  });

  it("current nightly at same core as just-shipped stable is older (no downgrade)", () => {
    // semverGt §11.4.1: equal core, no-prerelease > has-prerelease.
    // Running 0.12.0-nightly.X right after 0.12.0 stable ships: stable is
    // newer, so switching channels does NOT cross-downgrade.
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0-nightly.20260518.42",
        latestStable: "0.12.0",
      }),
    ).toBe(false);
  });

  it("current is plain semver newer than latest stable (downgrade)", () => {
    // Belt-and-suspenders: a non-prerelease current version greater than
    // latestStable still triggers downgrade. (Practically rare for nightly→
    // stable, but exercises semverGt's no-prerelease-on-both branch.)
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.12.0",
        latestStable: "0.11.1",
      }),
    ).toBe(true);
  });

  it("identical core and identical prerelease is not a downgrade", () => {
    // currentVersion === latestStable should return false even if both happen
    // to carry the same prerelease tag (defensive — practical case is two
    // stables that happen to match).
    expect(
      isCrossChannelDowngrade({
        from: "nightly",
        to: "stable",
        currentVersion: "0.11.1",
        latestStable: "0.11.1",
      }),
    ).toBe(false);
  });
});
