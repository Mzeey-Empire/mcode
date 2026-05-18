/**
 * Configures electron-updater to check GitHub Releases for new versions.
 * Checks once on launch, then on a configurable interval while running.
 *
 * Surfaces update lifecycle events to the renderer over IPC so the UI can
 * render an in-app banner and an "About" panel showing current state.
 * Also fires a native OS Notification when an update finishes downloading.
 *
 * Update behavior (release line, auto-download, auto-install, check interval)
 * is read from settings.json. Release line changes apply on the next check;
 * check interval still applies after restart (timer started at launch).
 */

import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, dialog, Notification } from "electron";
import type { Event } from "electron";
import { readFileSync } from "fs";
import { join } from "path";
import { getMcodeDir } from "@mcode/shared";
import { SettingsSchema as BundledSettingsSchema } from "@mcode/contracts";

/** Use snapshot-provided schema when available (V8 snapshot pre-initializes Zod). */
const SettingsSchema = globalThis.__v8Snapshot?.contracts?.SettingsSchema ?? BundledSettingsSchema;

/** Map from user-friendly interval names to milliseconds. */
const INTERVAL_MS_MAP: Record<string, number> = {
  "15min": 15 * 60 * 1000,
  "1hour": 60 * 60 * 1000,
  "4hours": 4 * 60 * 60 * 1000,
  "1day": 24 * 60 * 60 * 1000,
  "never": Infinity,
};

interface UpdaterSettings {
  /** Stable follows tagged releases; nightly follows the CI prerelease channel. */
  releaseLine: "stable" | "nightly";
  autoDownload: boolean;
  autoInstallOnQuit: boolean;
  checkInterval: string;
}

/**
 * Maps persisted `updates.channel` to the electron-updater publish channel name.
 */
function releaseLineToUpdaterChannel(releaseLine: "stable" | "nightly"): string {
  return releaseLine === "nightly" ? "nightly" : "latest";
}

/**
 * Applies `autoUpdater.channel` from user settings so checks target stable or nightly feeds.
 */
function applyUpdaterChannelFromSettings(settings: UpdaterSettings): void {
  autoUpdater.channel = releaseLineToUpdaterChannel(settings.releaseLine);
}

/** Read updater settings from settings.json; falls back to safe defaults if the file is missing or invalid. */
function loadUpdaterSettings(): UpdaterSettings {
  const defaults: UpdaterSettings = {
    releaseLine: "stable",
    autoDownload: true,
    autoInstallOnQuit: true,
    checkInterval: "4hours",
  };
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const result = SettingsSchema().safeParse(JSON.parse(raw));
    if (result.success) {
      return {
        releaseLine: result.data.updates?.channel ?? defaults.releaseLine,
        autoDownload: result.data.updates?.autoDownload ?? defaults.autoDownload,
        autoInstallOnQuit: result.data.updates?.autoInstallOnQuit ?? defaults.autoInstallOnQuit,
        checkInterval: result.data.updates?.checkInterval ?? defaults.checkInterval,
      };
    }
    console.warn("[auto-updater] settings.json failed validation, using defaults");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[auto-updater] settings.json could not be loaded, using defaults: ${message}`);
    }
  }
  return defaults;
}

/** Convert a check-interval name to milliseconds, defaulting to 4 hours. */
function intervalToMs(interval: string): number {
  return INTERVAL_MS_MAP[interval] ?? (4 * 60 * 60 * 1000);
}

/** IPC push channel used to broadcast update status to the renderer. */
export const UPDATE_STATUS_CHANNEL = "app:update-status";

/** Discriminated union describing the current state of the update workflow. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; bytesPerSecond?: number }
  | { state: "downloaded"; version: string; releaseNotes?: string }
  | { state: "error"; message: string };

let lastStatus: UpdateStatus = { state: "idle" };
let initialized = false;
let checkIntervalId: NodeJS.Timeout | null = null;
let initialCheckTimeoutId: NodeJS.Timeout | null = null;
/** Guards against promptRestart being invoked twice concurrently (notification click + direct call). */
let isPrompting = false;

/** Hook called before quitAndInstall to allow cleanup (e.g., stopping the server). */
let beforeInstallHook: (() => Promise<void>) | null = null;

/**
 * Skips redundant server-stop work once we have deferred quit to wait for teardown.
 * Matches our own before-quit handler on the synthetic second quit().
 */
let isCompletingStoppedServerQuit = false;

/**
 * Register a callback that runs before every quitAndInstall.
 * Used by main.ts to inject server shutdown so the installer
 * does not hit locked files from the detached server process.
 */
export function setBeforeInstallHook(hook: () => Promise<void>): void {
  beforeInstallHook = hook;
}

/**
 * Stop the server (if hook registered), then run the installer.
 * All code paths that previously called autoUpdater.quitAndInstall()
 * must use this instead.
 */
async function quitAndInstallSafely(): Promise<void> {
  isCompletingStoppedServerQuit = true;
  if (beforeInstallHook) {
    try {
      await beforeInstallHook();
    } catch (err) {
      console.error("[auto-updater] beforeInstallHook failed, proceeding with install:", err);
    }
  }
  autoUpdater.quitAndInstall();
}

/** Returns the most recently observed update status (for renderer hydration). */
export function getUpdateStatus(): UpdateStatus {
  return lastStatus;
}

/** Returns true once initAutoUpdater has run (and therefore in a packaged build). */
export function isUpdaterEnabled(): boolean {
  return initialized;
}

/** Broadcast a status change to all open windows. */
function broadcastStatus(status: UpdateStatus): void {
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(UPDATE_STATUS_CHANNEL, status);
    }
  }
}

/** Shared promise so concurrent callers wait for the active check to finish. */
let inFlightCheck: Promise<UpdateStatus> | null = null;

/**
 * Manually trigger a check for updates.
 * Safe to call from the renderer; resolves once the check completes.
 * Concurrent callers share the same in-flight check.
 */
export function checkForUpdatesNow(): Promise<UpdateStatus> {
  if (!initialized) {
    return Promise.resolve({ state: "not-available", version: app.getVersion() });
  }
  if (inFlightCheck) {
    return inFlightCheck;
  }
  inFlightCheck = (async () => {
    try {
      // Re-read settings so toggles and release line in the UI take effect
      // without an app restart.
      const settings = loadUpdaterSettings();
      applyUpdaterChannelFromSettings(settings);
      autoUpdater.autoDownload = settings.autoDownload;
      autoUpdater.autoInstallOnAppQuit = settings.autoInstallOnQuit;

      broadcastStatus({ state: "checking" });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcastStatus({ state: "error", message });
    } finally {
      inFlightCheck = null;
    }
    return lastStatus;
  })();
  return inFlightCheck;
}

/** Quit and install a downloaded update. Returns false in dev or if nothing is downloaded. */
export async function installUpdate(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (lastStatus.state !== "downloaded") return false;
  await quitAndInstallSafely();
  return true;
}

/**
 * Trigger a manual download of a discovered update.
 * Used when autoDownload is off and the user clicks "Download" in the banner.
 */
export async function downloadUpdate(): Promise<void> {
  if (!initialized) return;
  if (lastStatus.state !== "available") return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcastStatus({ state: "error", message });
  }
}

/**
 * When `electron-updater` will install on quit, Electron may exit while the detached server
 * still holds DLLs inside the install prefix. Deferred quit frees those handles first.
 */
function onBeforeQuitForPendingInstall(event: Event): void {
  if (isCompletingStoppedServerQuit) return;
  if (!app.isPackaged) return;
  if (!initialized) return;
  const { autoInstallOnQuit } = loadUpdaterSettings();
  if (!autoInstallOnQuit || lastStatus.state !== "downloaded") return;

  event.preventDefault();
  isCompletingStoppedServerQuit = true;
  void (async () => {
    try {
      if (beforeInstallHook) await beforeInstallHook();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[auto-updater] server stop failed before silent install on quit:", message);
    } finally {
      app.quit();
    }
  })();
}

/**
 * Initializes auto-update checks. Call once after app "ready" fires.
 * No-op in dev (no packaged app to update).
 */
export function initAutoUpdater(): void {
  if (initialized) return;
  initialized = true;
  app.on("before-quit", onBeforeQuitForPendingInstall);

  // In dev, force electron-updater to read dev-app-update.yml so we can
  // test the check/download flow without a packaged build.
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }

  autoUpdater.allowDowngrade = false;

  const updaterSettings = loadUpdaterSettings();
  applyUpdaterChannelFromSettings(updaterSettings);
  autoUpdater.autoDownload = updaterSettings.autoDownload;
  autoUpdater.autoInstallOnAppQuit = updaterSettings.autoInstallOnQuit;
  const { checkInterval } = updaterSettings;

  autoUpdater.on("checking-for-update", () => {
    broadcastStatus({ state: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    broadcastStatus({
      state: "available",
      version: info.version,
      releaseNotes: stringifyReleaseNotes(info.releaseNotes),
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    broadcastStatus({
      state: "not-available",
      version: info?.version ?? app.getVersion(),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    broadcastStatus({
      state: "downloading",
      percent: Math.round(progress.percent ?? 0),
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const releaseNotes = stringifyReleaseNotes(info.releaseNotes);
    broadcastStatus({
      state: "downloaded",
      version: info.version,
      releaseNotes,
    });

    // Fire a native OS notification so the user is aware even if Mcode
    // is in the background. Falls back to the in-app banner via IPC.
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: "Mcode update ready",
        body: `Version ${info.version} has been downloaded. Restart to install.`,
      });
      notification.on("click", () => {
        if (!isPrompting) void promptRestart(info.version);
      });
      notification.show();
    }

    // Also keep the existing modal as a hard prompt so users who only
    // see the chrome get a clear restart affordance.
    if (!isPrompting) {
      isPrompting = true;
      try {
        await promptRestart(info.version);
      } finally {
        isPrompting = false;
      }
    }
  });

  autoUpdater.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[auto-updater] Error checking for updates:", message);
    broadcastStatus({ state: "error", message });
  });

  // Initial check shortly after launch (give the window time to load)
  initialCheckTimeoutId = setTimeout(() => {
    void checkForUpdatesNow();
  }, 10_000);

  // Periodic checks using the configured interval
  const intervalMs = intervalToMs(checkInterval);
  if (isFinite(intervalMs)) {
    checkIntervalId = setInterval(() => {
      void checkForUpdatesNow();
    }, intervalMs);
  }
}

/**
 * Clean up timers and listeners when the app is shutting down.
 * Call from app "quit" or "will-quit" event.
 */
export function cleanupAutoUpdater(): void {
  app.removeListener("before-quit", onBeforeQuitForPendingInstall);
  if (initialCheckTimeoutId) {
    clearTimeout(initialCheckTimeoutId);
    initialCheckTimeoutId = null;
  }
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }
  autoUpdater.removeAllListeners();
}

/** Prompt the user to restart and install a downloaded update. */
async function promptRestart(version: string): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;

  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    title: "Update Ready",
    message: `Version ${version} has been downloaded. Restart to apply.`,
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
  });

  if (response === 0 && app.isPackaged) {
    await quitAndInstallSafely();
  }
}

/**
 * Normalize release notes into a plain string. electron-updater can return
 * either a string, an array of {version, note} entries, or null.
 */
function stringifyReleaseNotes(
  notes: string | Array<{ version: string; note: string | null }> | null | undefined,
): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === "string") return notes;
  return notes
    .map((entry) => entry.note?.trim())
    .filter((note): note is string => Boolean(note))
    .join("\n\n");
}
