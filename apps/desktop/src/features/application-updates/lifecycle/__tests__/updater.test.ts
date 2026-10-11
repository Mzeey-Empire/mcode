import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpdateStatusState } from "../../state/update-status";
import { createUpdaterLifecycle } from "../updater";

const { notificationMock } = vi.hoisted(() => ({
  notificationMock: {
    on: vi.fn(),
    show: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  Notification: Object.assign(function Notification() {
    return notificationMock;
  }, {
    isSupported: vi.fn(() => true),
  }),
}));

function createLifecycle() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const updater = {
    channel: "",
    allowPrerelease: false,
    allowDowngrade: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    removeAllListeners: vi.fn(() => listeners.clear()),
  };
  const application = {
    isPackaged: false,
    getVersion: vi.fn(() => "0.13.0"),
    on: vi.fn(),
    removeListener: vi.fn(),
    quit: vi.fn(),
  };
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const windows = {
    getAllWindows: vi.fn(() => [window]),
    getFocusedWindow: vi.fn(() => null),
  };
  const timer = {
    setTimeout: vi.fn((callback: () => void) => setTimeout(callback, 10_000)),
    clearTimeout: vi.fn((handle: unknown) => clearTimeout(handle as NodeJS.Timeout)),
    setInterval: vi.fn((callback: () => void, delay: number) =>
      setInterval(callback, delay),
    ),
    clearInterval: vi.fn((handle: unknown) => clearInterval(handle as NodeJS.Timeout)),
    setImmediate: vi.fn((callback: () => void) => setImmediate(callback)),
  };
  const status = createUpdateStatusState(windows);
  const installation = {
    register: vi.fn(),
    cleanup: vi.fn(),
    createBeforeInstallHook: vi.fn(),
    setBeforeInstallHook: vi.fn(),
    installUpdate: vi.fn(),
    installWhenIdle: vi.fn(),
    cancelInstallWhenIdle: vi.fn(),
  };
  const lifecycle = createUpdaterLifecycle({
    updater,
    application,
    windows,
    timer,
    settings: vi.fn(() => ({
      releaseLine: "stable" as const,
      autoDownload: true,
      autoInstallOnQuit: true,
      checkInterval: "never",
    })),
    status,
    installation,
  });
  lifecycle.initialize();
  return { lifecycle, updater, listeners, status, timer, installation };
}

describe("updater lifecycle", () => {
  let current: ReturnType<typeof createLifecycle>;

  afterEach(() => {
    current.lifecycle.cleanup();
  });

  it("publishes the updater event status contract", () => {
    current = createLifecycle();
    current.listeners.get("update-available")?.({
      version: "0.14.0",
      releaseNotes: "Bug fixes",
    });
    expect(current.status.get()).toEqual({
      state: "available",
      version: "0.14.0",
      releaseNotes: "Bug fixes",
    });

    current.listeners.get("download-progress")?.({
      percent: 42.4,
      bytesPerSecond: 1024,
    });
    expect(current.status.get()).toEqual({
      state: "downloading",
      percent: 42,
      bytesPerSecond: 1024,
    });

    current.listeners.get("update-downloaded")?.({
      version: "0.14.0",
      releaseNotes: [{ version: "0.14.0", note: "Bug fixes" }],
    });
    expect(current.status.get()).toEqual({
      state: "downloaded",
      version: "0.14.0",
      releaseNotes: "Bug fixes",
      installWhenIdle: false,
    });
  });

  it("deduplicates concurrent manual checks", async () => {
    current = createLifecycle();
    let resolveCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveCheck = resolve)),
    );

    const first = current.lifecycle.checkForUpdatesNow();
    const second = current.lifecycle.checkForUpdatesNow();
    expect(second).toBe(first);
    resolveCheck?.();
    await expect(first).resolves.toEqual({ state: "checking" });
    expect(current.updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("applies manual download errors to status", async () => {
    current = createLifecycle();
    current.listeners.get("update-available")?.({ version: "0.14.0" });
    current.updater.downloadUpdate.mockRejectedValueOnce(
      new Error("download failed"),
    );

    await current.lifecycle.downloadUpdate();

    expect(current.status.get()).toEqual({
      state: "error",
      message: "download failed",
      failedOperation: "download",
    });
    await current.lifecycle.downloadUpdate();
    expect(current.updater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(current.status.get()).toEqual({ state: "downloading", percent: 0 });
  });

  it("classifies transient check errors so the renderer can retry", () => {
    current = createLifecycle();
    current.listeners.get("error")?.(new Error("net::ERR_TIMED_OUT"));

    expect(current.status.get()).toEqual({
      state: "error", message: "net::ERR_TIMED_OUT", failedOperation: "check",
    });
  });

  it.each(["signature invalid", "net::ERR_TIMED_OUT"])("retries download-phase error events: %s", async (message) => {
    current = createLifecycle();
    current.listeners.get("download-progress")?.({ percent: 42 });
    current.listeners.get("error")?.(new Error(message));

    expect(current.status.get()).toEqual({ state: "error", message, failedOperation: "download" });
    await current.lifecycle.downloadUpdate();
    expect(current.updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(current.status.get()).toEqual({ state: "downloading", percent: 0 });
  });

  it("classifies rejected checks for retry through the check channel", async () => {
    current = createLifecycle();
    current.updater.checkForUpdates.mockRejectedValueOnce(new Error("check failed"));

    await expect(current.lifecycle.checkForUpdatesNow()).resolves.toEqual({
      state: "error", message: "check failed", failedOperation: "check",
    });
    await current.lifecycle.checkForUpdatesNow();
    expect(current.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("publishes a newly downloaded update with idle installation disabled", () => {
    current = createLifecycle();
    current.listeners.get("update-downloaded")?.({ version: "0.14.0", releaseNotes: "Bug fixes" });

    expect(current.status.get()).toEqual({
      state: "downloaded", version: "0.14.0", releaseNotes: "Bug fixes", installWhenIdle: false,
    });
  });

  it("does not download again from check or install errors", async () => {
    current = createLifecycle();
    current.status.publish({ state: "error", message: "check failed", failedOperation: "check" });
    await current.lifecycle.downloadUpdate();
    current.status.publish({ state: "error", message: "install failed", failedOperation: "install" });
    await current.lifecycle.downloadUpdate();

    expect(current.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("surfaces non-transient update failures", () => {
    current = createLifecycle();
    current.listeners.get("error")?.(new Error("signature invalid"));

    expect(current.status.get()).toEqual({
      state: "error",
      message: "signature invalid",
      failedOperation: "check",
    });
  });

  it("shares concurrent release-line switches", async () => {
    current = createLifecycle();
    let resolveCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveCheck = resolve)),
    );

    const first = current.lifecycle.applyReleaseLineSwitch("nightly");
    const second = current.lifecycle.applyReleaseLineSwitch("stable");
    resolveCheck?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(firstResult).toEqual({ state: "checking" });
  });

  it("removes listeners and timers and blocks stale results after cleanup", async () => {
    current = createLifecycle();
    let resolveCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveCheck = resolve)),
    );
    const check = current.lifecycle.checkForUpdatesNow();

    current.lifecycle.cleanup();
    resolveCheck?.();
    await check;

    expect(current.updater.removeAllListeners).toHaveBeenCalledOnce();
    expect(current.timer.clearTimeout).toHaveBeenCalledOnce();
    expect(current.installation.cleanup).toHaveBeenCalledOnce();
    expect(current.status.get()).toEqual({ state: "checking" });
  });

  it("reinitializes with fresh status and work after a pending check", async () => {
    current = createLifecycle();
    let resolveOldCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveOldCheck = resolve)),
    );
    const oldCheck = current.lifecycle.checkForUpdatesNow();

    current.lifecycle.cleanup();
    current.lifecycle.initialize();
    expect(current.status.get()).toEqual({ state: "idle" });

    current.updater.checkForUpdates.mockResolvedValueOnce(undefined);
    const freshCheck = current.lifecycle.checkForUpdatesNow();

    expect(freshCheck).not.toBe(oldCheck);
    expect(current.status.get()).toEqual({ state: "checking" });
    resolveOldCheck?.();
    await Promise.all([oldCheck, freshCheck]);
    expect(current.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh release switch after cleanup cancels a pending switch", async () => {
    current = createLifecycle();
    let resolveOldCheck: (() => void) | undefined;
    current.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveOldCheck = resolve)),
    );
    const oldSwitch = current.lifecycle.applyReleaseLineSwitch("nightly");

    current.lifecycle.cleanup();
    current.lifecycle.initialize();
    expect(current.status.get()).toEqual({ state: "idle" });

    current.updater.checkForUpdates.mockResolvedValueOnce(undefined);
    const freshSwitch = current.lifecycle.applyReleaseLineSwitch("stable");

    expect(freshSwitch).not.toBe(oldSwitch);
    expect(current.status.get()).toEqual({ state: "checking" });
    resolveOldCheck?.();
    await Promise.all([oldSwitch, freshSwitch]);
    expect(current.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
