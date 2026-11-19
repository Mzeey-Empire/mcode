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

/** Caller intent for a manual install. */
export interface InstallUpdateRequest {
  /** The user already confirmed restarting while agents run, so skip the agent count. */
  readonly confirmed?: boolean;
}

/**
 * Outcome of a manual install request. `agents-running` asks the caller to
 * confirm; `runningAgents` is null when the count could not be read, which
 * counts as busy because an unreadable count is not evidence of idleness.
 */
export type InstallUpdateResult =
  | { readonly kind: "started" }
  | { readonly kind: "agents-running"; readonly runningAgents: number | null }
  | { readonly kind: "refused"; readonly message: string };

type InstallRefused = Extract<InstallUpdateResult, { kind: "refused" }>;

const STARTED: InstallUpdateResult = { kind: "started" };

/** Installation operations owned by one Application Updates instance. */
export interface InstallationLifecycle {
  createBeforeInstallHook(forceReplace: () => Promise<void>): BeforeInstallHook;
  setBeforeInstallHook(hook: BeforeInstallHook): void;
  /** Install the downloaded update, asking for confirmation while agents run unless already confirmed. */
  installUpdate(request?: InstallUpdateRequest): Promise<InstallUpdateResult>;
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
  let installInFlight: Promise<InstallUpdateResult> | null = null;

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

  const installRefusalReason = (): string | null => {
    if (!active) return "the updater is not running";
    if (!application.isPackaged) return "updates install only from the packaged app";
    if (!installableUpdate()) return "no downloaded update is ready to install";
    return null;
  };

  const readRunningAgents = async (): Promise<number | null> => {
    try {
      return await getActiveAgentCount();
    } catch {
      return null;
    }
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

  const publishBlockedInstall = (logMessage: string, statusMessage = logMessage): InstallRefused => {
    console.error(`[auto-updater] ${logMessage}`);
    const message = `Update installation blocked: ${statusMessage}`;
    status.publish({ state: "error", message, failedOperation: "install" });
    return { kind: "refused", message };
  };

  const refuseInstall = (reason: string): InstallRefused => publishBlockedInstall(reason);

  const abandonInterruptedInstall = (): InstallRefused =>
    refuseInstall("the updater was reset while installing, try again");

  const runBeforeInstallHook = async (
    operationGeneration: number,
    failureContext: string,
  ): Promise<"ran" | "stale" | InstallRefused> => {
    if (!beforeInstallHook) return "ran";
    try {
      await beforeInstallHook();
      return "ran";
    } catch (error) {
      if (!operationIsCurrent(operationGeneration)) return "stale";
      const message = error instanceof Error ? error.message : String(error);
      return publishBlockedInstall(`${failureContext}: ${message}`, message);
    }
  };

  const awaitQuitAndInstall = async (): Promise<void> => {
    const initiation = updater.quitAndInstall();
    if (initiation === false) throw new Error("Update installer did not begin application shutdown");
    if (isPromiseLike(initiation)) await initiation;
  };

  const finishInstallerQuit = (operationGeneration: number): InstallUpdateResult | null => {
    if (!operationIsCurrent(operationGeneration)) return null;
    isCompletingStoppedServerQuit = false;
    if (installerQuitObserved) return STARTED;
    return publishBlockedInstall("Update installer did not begin application shutdown");
  };

  const runQuitAndInstall = async (): Promise<InstallUpdateResult> => {
    cancelInstallWhenIdle();
    const operationGeneration = generation;
    const hook = await runBeforeInstallHook(operationGeneration, "beforeInstallHook failed, cancelling install");
    if (hook !== "ran") {
      return hook !== "stale" && operationIsCurrent(operationGeneration) ? hook : abandonInterruptedInstall();
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
      return publishBlockedInstall(`quitAndInstall failed: ${message}`, message);
    }
    await new Promise<void>((resolve) => timer.setImmediate(resolve));
    return finishInstallerQuit(operationGeneration) ?? abandonInterruptedInstall();
  };

  /**
   * Stop the server and start the installer after Electron observes the quit.
   * Concurrent callers share one run: the teardown hook stops the server and
   * must not run again while the first attempt is still waiting on it.
   */
  const quitAndInstallSafely = (): Promise<InstallUpdateResult> => {
    if (installInFlight) return installInFlight;
    const run: Promise<InstallUpdateResult> = runQuitAndInstall().finally(() => {
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
    if ((await runBeforeInstallHook(operationGeneration, "server stop failed before silent install on quit")) !== "ran") return;
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
    installUpdate: async (request) => {
      if (installInFlight) return installInFlight;
      if (installRefusalReason() === null && request?.confirmed !== true) {
        const runningAgents = await readRunningAgents();
        if (installInFlight) return installInFlight;
        if (runningAgents !== 0) return { kind: "agents-running", runningAgents };
      }
      cancelInstallWhenIdle();
      const reason = installRefusalReason();
      if (reason) return refuseInstall(reason);
      const update = installableUpdate();
      if (update && status.get().state !== "downloaded") status.publish(update);
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
