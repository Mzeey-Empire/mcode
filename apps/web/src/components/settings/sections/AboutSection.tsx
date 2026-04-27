import { useState, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useUpdateStore } from "@/stores/updateStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SectionHeading } from "../SectionHeading";
import { Switch } from "@/components/ui/switch";
import { SegControl } from "../SegControl";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import type { UpdateCheckInterval } from "@mcode/contracts";

/** Segmented control options for update check frequency. */
const INTERVAL_OPTIONS = [
  { value: "15min", label: "15m" },
  { value: "1hour", label: "1h" },
  { value: "4hours", label: "4h" },
  { value: "1day", label: "1d" },
  { value: "never", label: "Off" },
];

/** How long to hold the "Up to date" label after a check resolves with no update (ms). */
const UP_TO_DATE_HOLD_MS = 4_000;

/**
 * About settings section: shows the running app version, the current
 * auto-updater state, and controls for update behavior.
 *
 * The version is read from the Electron main process at startup, so it
 * always reflects the installed build without manual maintenance.
 */
export function AboutSection() {
  const version = useUpdateStore((s) => s.version);
  const status = useUpdateStore((s) => s.status);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);

  /** True while a manually-triggered check is in flight. */
  const [checking, setChecking] = useState(false);
  /** Transient label shown for UP_TO_DATE_HOLD_MS after "no update" resolves. */
  const [upToDateLabel, setUpToDateLabel] = useState(false);
  const upToDateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bridge = typeof window !== "undefined" ? window.desktopBridge?.app : undefined;

  // When the status transitions to "not-available" after we were checking,
  // briefly show "Up to date" so the user sees the result of their click.
  const prevStatusRef = useRef(status.state);
  useEffect(() => {
    if (
      prevStatusRef.current === "checking" &&
      status.state === "not-available"
    ) {
      setUpToDateLabel(true);
      if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
      upToDateTimer.current = setTimeout(() => {
        setUpToDateLabel(false);
      }, UP_TO_DATE_HOLD_MS);
    }
    // Any active update state clears the transient label.
    if (
      status.state === "available" ||
      status.state === "downloading" ||
      status.state === "downloaded"
    ) {
      setUpToDateLabel(false);
      if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
    }
    prevStatusRef.current = status.state;
  }, [status.state]);

  // Clean up timer on unmount.
  useEffect(() => () => {
    if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
  }, []);

  const handleCheck = async (): Promise<void> => {
    if (!bridge) return;
    setUpToDateLabel(false);
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

  const autoDownload = settings.updates?.autoDownload ?? true;
  const autoInstallOnQuit = settings.updates?.autoInstallOnQuit ?? true;
  const checkInterval = settings.updates?.checkInterval ?? "4hours";

  const isBusy = checking || status.state === "checking" || status.state === "downloading";

  // Derive the inline status label shown beside the button.
  const statusLabel = upToDateLabel ? "Up to date" : describeStatus(status);

  return (
    <div>
      <SectionHeading>About</SectionHeading>
      <div>
        <SettingRow label="Version" hint="Currently installed build.">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {version || "—"}
          </span>
        </SettingRow>

        <SettingRow
          label="Updates"
          hint={
            checkInterval === "never"
              ? "Automatic checks disabled."
              : "Checks for new releases on the configured interval."
          }
        >
          <div className="flex items-center gap-3">
            {statusLabel && (
              <span
                className="font-mono text-xs text-muted-foreground transition-opacity duration-300"
                aria-live="polite"
              >
                {statusLabel}
              </span>
            )}

            {status.state === "downloaded" ? (
              <button
                onClick={handleInstall}
                className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Restart to install
              </button>
            ) : (
              <button
                onClick={() => void handleCheck()}
                disabled={!bridge || isBusy}
                className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={isBusy ? "Checking for updates…" : "Check for updates now"}
              >
                {isBusy && (
                  <Loader2
                    size={11}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                )}
                {isBusy ? "Checking…" : "Check now"}
              </button>
            )}
          </div>
        </SettingRow>

        <SettingRow
          label="Check interval"
          hint="How often to poll for new releases. Takes effect on next launch."
        >
          <SegControl
            options={INTERVAL_OPTIONS}
            value={checkInterval}
            onChange={(v) =>
              void updateSettings({
                updates: { checkInterval: v as UpdateCheckInterval },
              })
            }
          />
        </SettingRow>

        <SettingRow
          label="Auto-download"
          hint="Download updates in the background as soon as they are available."
        >
          <Switch
            checked={autoDownload}
            onCheckedChange={(v) =>
              void updateSettings({ updates: { autoDownload: v } })
            }
          />
        </SettingRow>

        <SettingRow
          label="Auto-install on quit"
          hint="Apply downloaded updates automatically when the app closes."
        >
          <Switch
            checked={autoInstallOnQuit}
            onCheckedChange={(v) =>
              void updateSettings({ updates: { autoInstallOnQuit: v } })
            }
          />
        </SettingRow>
      </div>
    </div>
  );
}

/**
 * Short status label shown beside the button.
 * @param status - Current update status from the Electron main process.
 * @returns Human-readable label, or empty string when nothing noteworthy is happening.
 */
function describeStatus(status: UpdateStatus): string {
  switch (status.state) {
    case "idle":
    case "not-available":
      return "";
    case "checking":
      return "Checking…";
    case "available":
      return `v${status.version} available`;
    case "downloading":
      return `${status.percent}%`;
    case "downloaded":
      return `v${status.version} ready`;
    case "error":
      return "Check failed";
  }
}
