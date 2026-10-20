import type { UpdaterClient, ApplicationLifecycle, UpdateTimer } from "./updater.js";
import type { UpdaterSettingsReader } from "../configuration/settings.js";
import type { UpdateStatus, UpdateStatusState } from "../state/update-status.js";

/** Event shape needed to defer Electron's pending-install quit. */
export interface BeforeQuitEvent {
  preventDefault(): void;
}

/** Hook called before an update installer or pending install quits. */
export type BeforeInstallHook = () => Promise<void>;

/** Dependencies owned by the installation lifecycle. */
export interface InstallationDependencies {
  updater: UpdaterClient;
  application: ApplicationLifecycle;
  timer: UpdateTimer;
  settings: UpdaterSettingsReader;
  status: UpdateStatusState;
  /** Read the server's current number of running agents. */
  getActiveAgentCount: () => Promise<number>;
}

/** Installation operations owned by one Application Updates instance. */
export interface InstallationLifecycle {
  createBeforeInstallHook(forceReplace: () => Promise<void>): BeforeInstallHook;
  setBeforeInstallHook(hook: BeforeInstallHook): void;
  installUpdate(): Promise<boolean>;
  /** Arm installation after two consecutive idle agent counts. */
  installWhenIdle(): void;
  /** Cancel a scheduled idle installation. */
  cancelInstallWhenIdle(): void;
  register(): void;
  cleanup(): void;
}

/** Build the updater installation lifecycle with explicit process dependencies. */
export function createInstallationLifecycle(
  dependencies: InstallationDependencies,
): InstallationLifecycle {
  const { updater, application, timer, settings, status, getActiveAgentCount } = dependencies;
  let beforeInstallHook: BeforeInstallHook | null = null;
  let isCompletingStoppedServerQuit = false;
  let installerQuitObserved = false;
  let active = false;
  let generation = 0;
  let idleInterval: unknown = null;
  let idleGeneration = 0;
  let idleStreak = 0;
  let pollInFlight = false;
  let unsubscribeStatus: (() => void) | null = null;
  let downloadedUpdate: Extract<UpdateStatus, { state: "downloaded" }> | null = null;
  let installInFlight: Promise<boolean> | null = null;

  const disarmIdleInstall = (): void => {
    if (idleInterval !== null) timer.clearInterval(idleInterval);
    idleInterval = null;
    idleStreak = 0;
    idleGeneration += 1;
  };

  const cancelInstallWhenIdle = (): void => {
    disarmIdleInstall();
    const current = status.get();
    if (current.state === "downloaded" && current.installWhenIdle) {
      status.publish({ ...current, installWhenIdle: false });
    }
  };

  const observeStatus = (current: UpdateStatus): void => {
    if (current.state === "downloaded") {
      downloadedUpdate = current;
      if (current.installWhenIdle) return;
    }
    disarmIdleInstall();
  };

  const pollForIdle = async (): Promise<void> => {
    if (pollInFlight || idleInterval === null) return;
    pollInFlight = true;
    const pollGeneration = idleGeneration;
    let count: number;
    try {
      count = await getActiveAgentCount();
    } catch {
      // An unreadable count is not evidence that it is safe to restart.
      if (pollGeneration === idleGeneration) idleStreak = 0;
      return;
    } finally {
      pollInFlight = false;
    }
    if (pollGeneration !== idleGeneration) return;
    idleStreak = count === 0 ? idleStreak + 1 : 0;
    if (idleStreak === 2) await quitAndInstallSafely();
  };

  // A failed install leaves the downloaded payload on disk, so a retry can install it again.
  const installableUpdate = (): Extract<UpdateStatus, { state: "downloaded" }> | null => {
    const current = status.get();
    if (current.state === "downloaded") return current;
    if (current.state === "error" && current.failedOperation === "install" && downloadedUpdate) {
      return { ...downloadedUpdate, installWhenIdle: false };
    }
    return null;
  };

  const installWhenIdle = (): void => {
    if (!active || !application.isPackaged || idleInterval !== null) return;
    const update = installableUpdate();
    if (!update) return;
    idleInterval = timer.setInterval(() => { void pollForIdle(); }, 5_000);
    status.publish({ ...update, installWhenIdle: true });
  };

  const createBeforeInstallHook = (
    forceReplace: () => Promise<void>,
  ): BeforeInstallHook => {
    return async () => {
      await forceReplace();
    };
  };

  const setBeforeInstallHook = (hook: BeforeInstallHook): void => {
    beforeInstallHook = hook;
  };

  const operationIsCurrent = (operationGeneration: number): boolean =>
    active && operationGeneration === generation;

  const publishBlockedInstall = (logMessage: string, statusMessage = logMessage): void => {
    console.error(`[auto-updater] ${logMessage}`);
    status.publish({ state: "error", message: `Update installation blocked: ${statusMessage}`, failedOperation: "install" });
  };

  const refuseInstall = (reason: string): false => {
    publishBlockedInstall(reason);
    return false;
  };

  const abandonInterruptedInstall = (): false =>
    refuseInstall("the updater was reset while installing, try again");

  const runBeforeInstallHook = async (
    operationGeneration: number,
    failureContext: string,
  ): Promise<boolean> => {
    if (!beforeInstallHook) return true;
    try {
      await beforeInstallHook();
      return true;
    } catch (error) {
      if (!operationIsCurrent(operationGeneration)) return false;
      const message = error instanceof Error ? error.message : String(error);
      publishBlockedInstall(`${failureContext}: ${message}`, message);
      return false;
    }
  };

  const awaitQuitAndInstall = async (): Promise<void> => {
    const initiation = updater.quitAndInstall();
    if (initiation === false) throw new Error("Update installer did not begin application shutdown");
    if (isPromiseLike(initiation)) await initiation;
  };

  const finishInstallerQuit = (operationGeneration: number): boolean => {
    if (!operationIsCurrent(operationGeneration)) return false;
    if (installerQuitObserved) {
      isCompletingStoppedServerQuit = false;
      return true;
    }
    isCompletingStoppedServerQuit = false;
    publishBlockedInstall("Update installer did not begin application shutdown");
    return false;
  };

  const runQuitAndInstall = async (): Promise<boolean> => {
    cancelInstallWhenIdle();
    const operationGeneration = generation;
    if (!(await runBeforeInstallHook(operationGeneration, "beforeInstallHook failed, cancelling install"))) {
      return operationIsCurrent(operationGeneration) ? false : abandonInterruptedInstall();
    }
    if (!operationIsCurrent(operationGeneration)) return abandonInterruptedInstall();
    installerQuitObserved = false;
    isCompletingStoppedServerQuit = true;
    try {
      await awaitQuitAndInstall();
    } catch (error) {
      if (operationGeneration !== generation) return abandonInterruptedInstall();
      isCompletingStoppedServerQuit = false;
      const message = error instanceof Error ? error.message : String(error);
      publishBlockedInstall(`quitAndInstall failed: ${message}`, message);
      return false;
    }
    await new Promise<void>((resolve) => timer.setImmediate(resolve));
    if (!operationIsCurrent(operationGeneration)) return abandonInterruptedInstall();
    return finishInstallerQuit(operationGeneration);
  };

  /**
   * Stop the server and start the installer after Electron observes the quit.
   * Concurrent callers share one run: the teardown hook stops the server and
   * must not run again while the first attempt is still waiting on it.
   */
  const quitAndInstallSafely = (): Promise<boolean> => {
    if (installInFlight) return installInFlight;
    const run: Promise<boolean> = runQuitAndInstall().finally(() => {
      if (installInFlight === run) installInFlight = null;
    });
    installInFlight = run;
    return run;
  };

  /** Handle Electron's pending-install quit path with deferred server teardown. */
  const onBeforeQuitForPendingInstall = (rawEvent: unknown): void => {
    const event = rawEvent as BeforeQuitEvent;
    if (isCompletingStoppedServerQuit) {
      installerQuitObserved = true;
      return;
    }
    if (!shouldDeferInstallOnQuit()) return;

    cancelInstallWhenIdle();
    event.preventDefault();
    installerQuitObserved = false;
    isCompletingStoppedServerQuit = true;
    void completePendingInstall(generation);
  };

  const shouldDeferInstallOnQuit = (): boolean =>
    active && application.isPackaged && settings().autoInstallOnQuit && status.get().state === "downloaded";

  const completePendingInstall = async (operationGeneration: number): Promise<void> => {
    if (!(await runBeforeInstallHook(operationGeneration, "server stop failed before silent install on quit"))) return;
    if (!operationIsCurrent(operationGeneration)) return;
    try {
      application.quit();
    } catch (error) {
      if (operationGeneration !== generation) return;
      isCompletingStoppedServerQuit = false;
      const message = error instanceof Error ? error.message : String(error);
      publishBlockedInstall(`deferred app quit failed: ${message}`, message);
      return;
    }
    finishInstallerQuit(operationGeneration);
  };

  return {
    createBeforeInstallHook,
    setBeforeInstallHook,
    installWhenIdle,
    cancelInstallWhenIdle,
    installUpdate: () => {
      if (installInFlight) return installInFlight;
      cancelInstallWhenIdle();
      if (!active) return Promise.resolve(refuseInstall("the updater is not running"));
      if (!application.isPackaged) return Promise.resolve(refuseInstall("updates install only from the packaged app"));
      const update = installableUpdate();
      if (!update) return Promise.resolve(refuseInstall("no downloaded update is ready to install"));
      if (status.get().state !== "downloaded") status.publish(update);
      return quitAndInstallSafely();
    },
    register: () => {
      if (active) return;
      active = true;
      observeStatus(status.get());
      unsubscribeStatus = status.subscribe(observeStatus);
      application.on("before-quit", onBeforeQuitForPendingInstall);
    },
    cleanup: () => {
      cancelInstallWhenIdle();
      unsubscribeStatus?.();
      unsubscribeStatus = null;
      downloadedUpdate = null;
      if (!active) {
        beforeInstallHook = null;
        return;
      }
      active = false;
      generation += 1;
      installInFlight = null;
      application.removeListener("before-quit", onBeforeQuitForPendingInstall);
      beforeInstallHook = null;
      isCompletingStoppedServerQuit = false;
      installerQuitObserved = false;
    },
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function";
}
