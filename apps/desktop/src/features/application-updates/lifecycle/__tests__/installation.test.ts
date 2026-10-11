import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUpdateStatusState } from "../../state/update-status";
import { createInstallationLifecycle } from "../installation";

function createLifecycle() {
  const listeners = new Map<string, (event: unknown) => void>();
  const updater = {
    quitAndInstall: vi.fn(),
  };
  const application = {
    isPackaged: true,
    getVersion: vi.fn(() => "0.13.0"),
    on: vi.fn((event: string, listener: (event: unknown) => void) => {
      listeners.set(event, listener);
    }),
    removeListener: vi.fn((event: string) => {
      listeners.delete(event);
    }),
    quit: vi.fn(),
  };
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const timer = {
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    setInterval: vi.fn((callback: () => void, delay: number) => setInterval(callback, delay)),
    clearInterval: vi.fn((handle: ReturnType<typeof setInterval>) => clearInterval(handle)),
    setImmediate: vi.fn((callback: () => void) => setImmediate(callback)),
  };
  const status = createUpdateStatusState({
    getAllWindows: () => [window],
    getFocusedWindow: () => null,
  });
  const getActiveAgentCount = vi.fn<() => Promise<number>>().mockResolvedValue(0);
  const lifecycle = createInstallationLifecycle({
    updater,
    application,
    timer,
    settings: vi.fn(() => ({
      releaseLine: "stable" as const,
      autoDownload: true,
      autoInstallOnQuit: true,
      checkInterval: "never",
    })),
    status,
    getActiveAgentCount,
  });
  return { lifecycle, updater, application, listeners, status, timer, getActiveAgentCount };
}

function markDownloaded(status: ReturnType<typeof createUpdateStatusState>): void {
  status.publish({ state: "downloaded", version: "0.14.0", releaseNotes: "Bug fixes", installWhenIdle: false });
}

describe("update installation lifecycle", () => {
  let current: ReturnType<typeof createLifecycle>;

  beforeEach(() => {
    current = createLifecycle();
    current.lifecycle.setBeforeInstallHook(async () => {});
    current.lifecycle.register();
    markDownloaded(current.status);
    current.updater.quitAndInstall.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });
  });

  afterEach(() => {
    current.lifecycle.cleanup();
    vi.useRealTimers();
  });

  it("blocks manual installation when server teardown fails", async () => {
    current.lifecycle.setBeforeInstallHook(async () => {
      throw new Error("server teardown failed");
    });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(false);

    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(current.status.get()).toEqual({
      state: "error",
      message: "Update installation blocked: server teardown failed",
      failedOperation: "install",
    });
  });

  it("resets the manual guard after installer failure", async () => {
    current.updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("installer crashed");
    });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(false);
    await expect(current.lifecycle.installUpdate()).resolves.toBe(true);

    expect(current.updater.quitAndInstall).toHaveBeenCalledTimes(2);
    expect(current.status.get()).toEqual({
      state: "downloaded", version: "0.14.0", releaseNotes: "Bug fixes", installWhenIdle: false,
    });
  });

  it("resets the manual guard when installation does not begin shutdown", async () => {
    current.updater.quitAndInstall.mockImplementationOnce(() => false);

    await expect(current.lifecycle.installUpdate()).resolves.toBe(false);
    markDownloaded(current.status);
    await expect(current.lifecycle.installUpdate()).resolves.toBe(true);

    expect(current.updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("accepts a deferred quit-and-install after before-quit arrives", async () => {
    current.updater.quitAndInstall.mockImplementationOnce(() => {
      setImmediate(() => current.application.quit());
    });
    current.application.quit.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(true);
    expect(current.application.quit).toHaveBeenCalledOnce();
  });

  it("keeps the app open when silent install teardown fails", async () => {
    current.lifecycle.setBeforeInstallHook(async () => {
      throw new Error("server teardown failed");
    });
    const event = { preventDefault: vi.fn() };

    current.listeners.get("before-quit")?.(event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(current.application.quit).not.toHaveBeenCalled();
    expect(current.status.get()).toEqual({
      state: "error",
      message: "Update installation blocked: server teardown failed",
      failedOperation: "install",
    });
  });

  it("keeps successful silent installation behavior", async () => {
    current.application.quit.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });
    const event = { preventDefault: vi.fn() };

    current.listeners.get("before-quit")?.(event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(current.application.quit).toHaveBeenCalledOnce();
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("builds and propagates the injected teardown hook", async () => {
    const forceReplace = vi.fn().mockResolvedValue(undefined);
    const hook = current.lifecycle.createBeforeInstallHook(forceReplace);

    await hook();

    expect(forceReplace).toHaveBeenCalledOnce();
    const failure = new Error("server teardown failed");
    forceReplace.mockRejectedValueOnce(failure);
    await expect(hook()).rejects.toBe(failure);
  });

  it("blocks stale installation work after cleanup", async () => {
    let resolveTeardown: (() => void) | undefined;
    current.lifecycle.setBeforeInstallHook(
      () => new Promise<void>((resolve) => (resolveTeardown = resolve)),
    );
    const install = current.lifecycle.installUpdate();

    current.lifecycle.cleanup();
    resolveTeardown?.();

    await expect(install).resolves.toBe(false);
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(current.application.removeListener).toHaveBeenCalledOnce();
  });

  it("resets the injected hook and guards before a later registration", async () => {
    const forceReplace = vi.fn().mockResolvedValue(undefined);
    current.lifecycle.setBeforeInstallHook(async () => forceReplace());
    current.lifecycle.cleanup();
    current.lifecycle.register();
    markDownloaded(current.status);
    current.updater.quitAndInstall.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(true);

    expect(forceReplace).not.toHaveBeenCalled();
    expect(current.updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("installs after two zero counts within ten seconds of the last active reading", async () => {
    vi.useFakeTimers();
    current.getActiveAgentCount.mockResolvedValueOnce(1);
    current.lifecycle.installWhenIdle();
    expect(current.status.get()).toEqual({
      state: "downloaded", version: "0.14.0", releaseNotes: "Bug fixes", installWhenIdle: true,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(current.getActiveAgentCount).toHaveBeenCalledTimes(3);
    expect(current.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(current.status.get()).toEqual({
      state: "downloaded", version: "0.14.0", releaseNotes: "Bug fixes", installWhenIdle: false,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(current.getActiveAgentCount).toHaveBeenCalledTimes(3);
  });

  it.each(["busy", "unreadable"])("resets the idle streak after a %s reading", async (reading) => {
    vi.useFakeTimers();
    current.getActiveAgentCount.mockResolvedValueOnce(0);
    if (reading === "busy") current.getActiveAgentCount.mockResolvedValueOnce(1);
    else current.getActiveAgentCount.mockRejectedValueOnce(new Error("server unavailable"));
    current.lifecycle.installWhenIdle();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(current.getActiveAgentCount).toHaveBeenCalledTimes(4);
  });

  it("cancels the poller and republishes the unarmed download", async () => {
    vi.useFakeTimers();
    current.lifecycle.installWhenIdle();
    await vi.advanceTimersByTimeAsync(5_000);
    current.lifecycle.cancelInstallWhenIdle();

    expect(current.status.get()).toEqual({
      state: "downloaded", version: "0.14.0", releaseNotes: "Bug fixes", installWhenIdle: false,
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(current.getActiveAgentCount).toHaveBeenCalledOnce();
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("keeps one poller when armed twice", async () => {
    vi.useFakeTimers();
    current.lifecycle.installWhenIdle();
    current.lifecycle.installWhenIdle();

    expect(current.timer.setInterval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current.getActiveAgentCount).toHaveBeenCalledOnce();
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not arm without a downloaded update", async () => {
    vi.useFakeTimers();
    current.status.publish({ state: "available", version: "0.14.0" });
    current.lifecycle.installWhenIdle();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(current.status.get()).toEqual({ state: "available", version: "0.14.0" });
    expect(vi.getTimerCount()).toBe(0);
    expect(current.getActiveAgentCount).not.toHaveBeenCalled();
  });

  it.each(["cleanup", "status change"])("disarms immediately on %s", async (action) => {
    vi.useFakeTimers();
    current.lifecycle.installWhenIdle();
    await vi.advanceTimersByTimeAsync(5_000);
    if (action === "cleanup") current.lifecycle.cleanup();
    else current.status.publish({ state: "checking" });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(current.getActiveAgentCount).toHaveBeenCalledOnce();
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not overlap slow counts or reuse a cancelled count after rearming", async () => {
    vi.useFakeTimers();
    let resolveCount: ((count: number) => void) | undefined;
    current.getActiveAgentCount.mockImplementationOnce(
      () => new Promise<number>((resolve) => { resolveCount = resolve; }),
    );
    current.lifecycle.installWhenIdle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(current.getActiveAgentCount).toHaveBeenCalledOnce();

    current.lifecycle.cancelInstallWhenIdle();
    current.lifecycle.installWhenIdle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current.getActiveAgentCount).toHaveBeenCalledOnce();
    resolveCount?.(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(current.getActiveAgentCount).toHaveBeenCalledTimes(3);
  });

  it("disarms before a direct install starts server teardown", async () => {
    vi.useFakeTimers();
    current.lifecycle.installWhenIdle();
    current.lifecycle.setBeforeInstallHook(async () => { throw new Error("server unavailable"); });

    await expect(current.lifecycle.installUpdate()).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(current.getActiveAgentCount).not.toHaveBeenCalled();
    expect(current.status.get()).toMatchObject({ state: "error", failedOperation: "install" });
  });

  it("publishes a retryable install error when idle installation is blocked", async () => {
    vi.useFakeTimers();
    current.lifecycle.setBeforeInstallHook(async () => { throw new Error("server unavailable"); });
    current.lifecycle.installWhenIdle();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(current.status.get()).toMatchObject({ state: "error", failedOperation: "install" });
    expect(vi.getTimerCount()).toBe(0);
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("retains auto-install-on-quit while armed", async () => {
    vi.useFakeTimers();
    current.application.quit.mockImplementation(() => {
      current.listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    });
    current.lifecycle.installWhenIdle();
    const event = { preventDefault: vi.fn() };
    current.listeners.get("before-quit")?.(event);
    await vi.advanceTimersByTimeAsync(0);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(current.application.quit).toHaveBeenCalledOnce();
    expect(current.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
