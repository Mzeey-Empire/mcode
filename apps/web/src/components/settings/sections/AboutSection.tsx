import { useState } from "react";
import { useUpdateStore } from "@/stores/updateStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SectionHeading } from "../SectionHeading";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import type { UpdateCheckInterval } from "@mcode/contracts";

/**
 * About settings section: shows the running app version, the current
 * auto-updater state, and a manual "Check for updates" button.
 *
 * The version is read from the Electron main process at startup, so it
 * always reflects the installed build without manual maintenance.
 */
export function AboutSection() {
  const version = useUpdateStore((s) => s.version);
  const status = useUpdateStore((s) => s.status);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const [checking, setChecking] = useState(false);

  const bridge = typeof window !== "undefined" ? window.desktopBridge?.app : undefined;

  const handleCheck = async (): Promise<void> => {
    if (!bridge) return;
    setChecking(true);
    try {
      await bridge.checkForUpdates();
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = (): void => {
    void bridge?.installUpdate();
  };

  const handleAutoDownloadChange = (enabled: boolean): void => {
    void updateSettings({ updates: { autoDownload: enabled } });
  };

  const handleAutoInstallChange = (enabled: boolean): void => {
    void updateSettings({ updates: { autoInstallOnQuit: enabled } });
  };

  const handleCheckIntervalChange = (interval: UpdateCheckInterval): void => {
    void updateSettings({ updates: { checkInterval: interval } });
  };

  const autoDownload = settings.updates?.autoDownload ?? true;
  const autoInstallOnQuit = settings.updates?.autoInstallOnQuit ?? true;
  const checkInterval = settings.updates?.checkInterval ?? "4hours";

  return (
    <div>
      <SectionHeading>About</SectionHeading>
      <div>
        <SettingRow
          label="Version"
          hint="The currently installed version of Mcode."
        >
          <span className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
            {version || "—"}
          </span>
        </SettingRow>

        <SettingRow
          label="Updates"
          hint="Check for new versions of Mcode."
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {describeStatus(status)}
            </span>
            {status.state === "downloaded" ? (
              <button
                onClick={handleInstall}
                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                Restart to install
              </button>
            ) : (
              <button
                onClick={() => void handleCheck()}
                disabled={!bridge || checking || status.state === "checking" || status.state === "downloading"}
                className="rounded bg-foreground/10 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {checking || status.state === "checking" ? "Checking…" : "Check now"}
              </button>
            )}
          </div>
        </SettingRow>

        <SettingRow
          label="Auto-download"
          hint="Automatically download updates when they become available."
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoDownload}
              onChange={(e) => handleAutoDownloadChange(e.target.checked)}
              className="h-4 w-4 rounded border border-input bg-background"
            />
            <span className="text-xs text-muted-foreground">
              {autoDownload ? "Enabled" : "Disabled"}
            </span>
          </label>
        </SettingRow>

        <SettingRow
          label="Auto-install"
          hint="Automatically install updates when the app closes."
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoInstallOnQuit}
              onChange={(e) => handleAutoInstallChange(e.target.checked)}
              className="h-4 w-4 rounded border border-input bg-background"
            />
            <span className="text-xs text-muted-foreground">
              {autoInstallOnQuit ? "Enabled" : "Disabled"}
            </span>
          </label>
        </SettingRow>

        <SettingRow
          label="Check interval"
          hint="How often to check for updates (takes effect on next app launch)."
        >
          <select
            value={checkInterval}
            onChange={(e) => handleCheckIntervalChange(e.target.value as UpdateCheckInterval)}
            className="rounded border border-input bg-background px-2 py-1.5 text-xs text-foreground"
          >
            <option value="15min">Every 15 minutes</option>
            <option value="1hour">Every hour</option>
            <option value="4hours">Every 4 hours</option>
            <option value="1day">Every day</option>
            <option value="never">Never</option>
          </select>
        </SettingRow>
      </div>
    </div>
  );
}

/** Render the auto-updater status as a short, user-facing string. */
function describeStatus(status: UpdateStatus): string {
  switch (status.state) {
    case "idle":
      return "Idle";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Version ${status.version} is available — downloading…`;
    case "not-available":
      return "You're on the latest version.";
    case "downloading":
      return `Downloading update… ${status.percent}%`;
    case "downloaded":
      return `Version ${status.version} is downloaded.`;
    case "error":
      return `Update check failed: ${status.message}`;
  }
}
