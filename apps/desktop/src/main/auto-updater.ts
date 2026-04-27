/**
 * Configures electron-updater to check GitHub Releases for new versions.
 * Checks once on launch, then on a configurable interval while running.
 *
 * Surfaces update lifecycle events to the renderer over IPC so the UI can
 * render an in-app banner and an "About" panel showing current state.
 * Also fires a native OS Notification when an update finishes downloading.
 *
 * Update behavior (auto-download, auto-install, check interval) is controlled
 * via user settings read from settings.json. Changes take effect on next app launch.
 */

import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, dialog, Notification } from "electron";
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
  autoDownload: boolean;
  autoInstallOnQuit: boolean;
  checkInterval: string;
}

/** Read updater settings from settings.json; falls back to safe defaults if the file is missing or invalid. */
function loadUpdaterSettings(): UpdaterSettings {
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const result = SettingsSchema().safeParse(JSON.parse(raw));
    if (result.success) {
      return {
        autoDownload: result.data.updates?.autoDownload ?? true,
        autoInstallOnQuit: result.data.updates?.autoInstallOnQuit ?? true,
        checkInterval: result.data.updates?.checkInterval ?? "4hours",
      };
    }
  } catch {
    // File missing or unreadable; use defaults
  }
  return { autoDownload: true, autoInstallOnQuit: true, checkInterval: "4hours" };
}

/** Get the configured check interval from settings, or 4 hours if settings cannot be read. */
function getCheckIntervalMs(): number {
  const { checkInterval } = loadUpdaterSettings();
  return INTERVAL_MS_MAP[checkInterval] ?? (4 * 60 * 60 * 1000);
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

/**
 * Manually trigger a check for updates.
 * Safe to call from the renderer; resolves once the check completes.
 */
export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  if (!initialized) {
    // In dev mode there is nothing to check against.
    return { state: "not-available", version: app.getVersion() };
  }
  try {
    broadcastStatus({ state: "checking" });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcastStatus({ state: "error", message });
  }
  return lastStatus;
}

/** Quit and install a downloaded update. No-op if nothing is downloaded. */
export function installUpdate(): void {
  if (!initialized) return;
  if (lastStatus.state !== "downloaded") return;
  autoUpdater.quitAndInstall();
}

/**
 * Initializes auto-update checks. Call once after app "ready" fires.
 * No-op in dev (no packaged app to update).
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  initialized = true;

  const { autoDownload, autoInstallOnQuit } = loadUpdaterSettings();
  autoUpdater.autoDownload = autoDownload;
  autoUpdater.autoInstallOnAppQuit = autoInstallOnQuit;

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
  const intervalMs = getCheckIntervalMs();
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
  if (!win) return;

  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    title: "Update Ready",
    message: `Version ${version} has been downloaded. Restart to apply.`,
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
  });

  if (response === 0) {
    autoUpdater.quitAndInstall();
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
