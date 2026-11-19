import { useEffect, useReducer, useRef, useState } from "react";
import { useUpdateStore } from "@/stores/updateStore";
import { useShallow } from "zustand/shallow";
import { useSettingsStore } from "@/stores/settingsStore";
import { Setting, SettingRowFrame } from "../Setting";
import { settingsPage, type SettingRowProps } from "../setting-def";
import { SettingsGroup } from "../SettingsGroup";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import type { BuildStage } from "@mcode/contracts/build-stage";
import type { Settings, UpdateCheckInterval, UpdateReleaseLine } from "@mcode/contracts/models/settings";
import { ConfirmChannelDowngradeDialog } from "./ConfirmChannelDowngradeDialog";
import { semverGt } from "@/lib/semver";
import { useInstallUpdate } from "@/features/updates/use-install-update";

/** Segmented control options for update release line (electron-updater publish channel). */
const RELEASE_LINE_OPTIONS: { value: UpdateReleaseLine; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
];

function upToDateLabelReducer(_visible: boolean, visible: boolean): boolean {
  return visible;
}

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

function getUpdatesHint(checkInterval: UpdateCheckInterval, releaseLine: UpdateReleaseLine): string {
  if (checkInterval === "never") return "Automatic checks disabled.";
  if (releaseLine === "nightly") return "Nightly uses prerelease builds. They may be unstable. Switching back to Stable while running a newer nightly will reinstall the latest stable after confirming.";
  return "Checks for new releases on the configured interval.";
}

function UpdateStatusControl({ status, statusLabel, canCheck, isBusy, installing, onInstall, onCheck }: { status: UpdateStatus; statusLabel: string; canCheck: boolean; isBusy: boolean; installing: boolean; onInstall: () => void; onCheck: () => void }) {
  return <div className="flex items-center gap-3">{statusLabel && <span className="font-mono text-xs text-muted transition-opacity duration-300" aria-live="polite">{statusLabel}</span>}{status.state === "downloaded" ? <button onClick={onInstall} disabled={installing} className="inline-flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-ink transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">{installing && <Spinner size={12} className="text-current" />}Restart to install</button> : <button onClick={onCheck} disabled={!canCheck || isBusy} className="inline-flex items-center gap-1.5 rounded bg-hover px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:bg-hover/80 disabled:cursor-not-allowed disabled:opacity-40" aria-label={isBusy ? "Checking for updates…" : "Check for updates now"}>{isBusy && <Spinner size={12} className="text-current" />}{isBusy ? "Checking…" : "Check now"}</button>}</div>;
}

const STAGE_LABEL: Record<BuildStage, string | null> = { dev: "Dev", nightly: "Nightly", stable: null };

function VersionValue({ version, stage }: { version: string | null | undefined; stage: BuildStage | null }) {
  const stageLabel = stage ? STAGE_LABEL[stage] : null;
  return <span className="flex items-center gap-2 font-mono text-xs text-muted tabular-nums"><span>{version || "—"}</span>{stageLabel && <span className="text-ink">{stageLabel}</span>}</span>;
}

function getUpdatePreferences(settings: Settings): { autoDownload: boolean; autoInstallOnQuit: boolean; checkInterval: UpdateCheckInterval; releaseLine: UpdateReleaseLine } {
  return { autoDownload: settings.updates?.autoDownload ?? true, autoInstallOnQuit: settings.updates?.autoInstallOnQuit ?? true, checkInterval: settings.updates?.checkInterval ?? "4hours", releaseLine: settings.updates?.channel ?? "stable" };
}

function useUpdatePreferences() {
  return useSettingsStore(useShallow((s) => getUpdatePreferences(s.settings)));
}

function isUpdateBusy(checking: boolean, status: UpdateStatus): boolean {
  return checking || status.state === "checking" || status.state === "downloading";
}

function getUpdateStatusLabel(upToDateLabel: boolean, status: UpdateStatus): string {
  return upToDateLabel ? "Up to date" : describeStatus(status);
}

function aboutBridge() {
  return typeof window !== "undefined" ? window.desktopBridge?.app : undefined;
}

function VersionControl() {
  const version = useUpdateStore((s) => s.version);
  const stage = useUpdateStore((s) => s.stage);
  return <VersionValue version={version} stage={stage} />;
}

/**
 * Updates row: the live check status and the Check now or Restart to install action.
 * Its hint follows the saved interval and release line, so the row draws it instead of the definition.
 */
function UpdatesRow({ def, variant }: SettingRowProps) {
  const status = useUpdateStore((s) => s.status);
  const { checkInterval, releaseLine } = useUpdatePreferences();
  const bridge = aboutBridge();

  /** True while a manually-triggered check is in flight. */
  const [checking, setChecking] = useState(false);
  /** Transient label shown for UP_TO_DATE_HOLD_MS after "no update" resolves. */
  const [upToDateLabel, setUpToDateLabel] = useReducer(upToDateLabelReducer, false);
  const upToDateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Show the "Up to date" label for a few seconds, then clear it. */
  const flashUpToDate = () => {
    setUpToDateLabel(true);
    if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
    upToDateTimer.current = setTimeout(() => {
      setUpToDateLabel(false);
    }, UP_TO_DATE_HOLD_MS);
  };

  // Any active update state clears the transient "Up to date" label.
  useEffect(() => {
    if (
      status.state === "available" ||
      status.state === "downloading" ||
      status.state === "downloaded"
    ) {
      setUpToDateLabel(false);
      if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
    }
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
      const result = await bridge.checkForUpdates();
      if (result.state === "not-available") {
        flashUpToDate();
      }
    } catch {
      // The main process broadcasts an error status via IPC, which surfaces as
      // status.state === "error" and renders the failed operation in the status label.
    } finally {
      setChecking(false);
    }
  };

  const { install, installing, dialog: installDialog } = useInstallUpdate(bridge);

  return (
    <SettingRowFrame def={def} variant={variant} hint={getUpdatesHint(checkInterval, releaseLine)}>
      <UpdateStatusControl
        status={status}
        statusLabel={getUpdateStatusLabel(upToDateLabel, status)}
        canCheck={Boolean(bridge)}
        isBusy={isUpdateBusy(checking, status)}
        installing={installing}
        onInstall={() => void install()}
        onCheck={() => void handleCheck()}
      />
      {installDialog}
    </SettingRowFrame>
  );
}

/**
 * Release line switch. Owns the downgrade confirmation and the queue of channel switches,
 * so choosing a line from search behaves exactly as on the About page.
 */
function ReleaseLineControl() {
  const version = useUpdateStore((s) => s.version);
  const { releaseLine } = useUpdatePreferences();
  const updateSettings = useSettingsStore((s) => s.update);
  /** Latest stable version on GitHub, used to decide if nightly→stable is a downgrade. */
  const [latestStable, setLatestStable] = useState<string | null>(null);
  /** When non-null, the dialog is shown for the pending downgrade. */
  const [pendingDowngrade, setPendingDowngrade] = useState<null | {
    currentVersion: string;
    latestStable: string;
  }>(null);

  /** The latest channel switch asked for, until it settles. Compared by identity: the same line can be queued twice. */
  const requestedLine = useRef<{ readonly line: UpdateReleaseLine } | null>(null);
  const channelSwitches = useRef<Promise<void>>(Promise.resolve());

  // Fetch the latest stable version once on mount. Used only to decide
  // whether nightly → stable is a downgrade. Failure is non-fatal — the
  // downgrade prompt simply won't appear.
  useEffect(() => {
    let cancelled = false;
    fetch("https://api.github.com/repos/mzeey-empire/mcode/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const tag = typeof data.tag_name === "string" ? data.tag_name : null;
        if (!tag) return;
        // Strip leading "v" or "mcode-v" prefix from release-please tags.
        const cleaned = tag.replace(/^mcode-v?/, "").replace(/^v/, "");
        setLatestStable(cleaned);
      })
      .catch(() => {
        // Silent — no downgrade prompt is the only consequence.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Persist the new channel AND tell the main process to switch the running
   * updater. Persistence MUST happen first because the main process's next
   * periodic check re-reads settings.json — see auto-updater.ts.
   */
  const persistChannel = async (
    next: UpdateReleaseLine,
    allowDowngrade: boolean,
  ): Promise<void> => {
    await updateSettings({ updates: { channel: next } });
    const bridge = aboutBridge();
    if (bridge?.applyReleaseLine) {
      await bridge.applyReleaseLine({ releaseLine: next, allowDowngrade });
    }
  };

  /**
   * Queue a channel switch behind any still in flight, so a quick Nightly then
   * Stable from the arrow keys reaches the updater in that order and Stable wins.
   */
  const applyChannelSwitch = (next: UpdateReleaseLine, allowDowngrade: boolean): Promise<void> => {
    const request = { line: next };
    requestedLine.current = request;
    const run = channelSwitches.current.then(() => persistChannel(next, allowDowngrade));
    // The queue only orders switches; each caller still sees its own failure through `run`.
    channelSwitches.current = run.catch(() => undefined);
    return run.finally(() => {
      if (requestedLine.current === request) requestedLine.current = null;
    });
  };

  /**
   * Handle a release-line change from the segmented control. Confirms with the user
   * when switching nightly → stable while running a newer-than-stable build,
   * because that path requires a downgrade install.
   */
  const handleChannelChange = async (next: UpdateReleaseLine): Promise<void> => {
    // `releaseLine` updates only after the settings round trip, so judge against the last line asked for.
    const currentLine = requestedLine.current?.line ?? releaseLine;
    if (next === currentLine) return;

    // Conservative: when nightly → stable and we don't yet know latestStable
    // (fetch pending or failed), assume the switch would be a downgrade so the
    // dialog still gates the change. Prevents a fast click from sliding past
    // the confirmation while the network call is in flight.
    const wouldDowngrade =
      currentLine === "nightly" && next === "stable" && version
        ? !latestStable || semverGt(version, latestStable)
        : false;

    if (wouldDowngrade) {
      setPendingDowngrade({
        currentVersion: version!,
        latestStable: latestStable ?? "the latest stable release",
      });
      return;
    }

    await applyChannelSwitch(next, false);
  };

  return (
    <>
      <SegmentedControl options={RELEASE_LINE_OPTIONS} value={releaseLine} onChange={(value) => void handleChannelChange(value as UpdateReleaseLine)} />
      {pendingDowngrade && (
        <ConfirmChannelDowngradeDialog
          currentVersion={pendingDowngrade.currentVersion}
          latestStable={pendingDowngrade.latestStable}
          onCancel={() => setPendingDowngrade(null)}
          onConfirm={async () => {
            await applyChannelSwitch("stable", true);
            setPendingDowngrade(null);
          }}
        />
      )}
    </>
  );
}

function CheckIntervalControl() {
  const { checkInterval } = useUpdatePreferences();
  const updateSettings = useSettingsStore((s) => s.update);
  return <SegmentedControl options={INTERVAL_OPTIONS} value={checkInterval} onChange={(value) => void updateSettings({ updates: { checkInterval: value as UpdateCheckInterval } })} />;
}

function AutoDownloadControl() {
  const { autoDownload } = useUpdatePreferences();
  const updateSettings = useSettingsStore((s) => s.update);
  return <Switch aria-label="Auto-download" checked={autoDownload} onCheckedChange={(value) => void updateSettings({ updates: { autoDownload: value } })} />;
}

function AutoInstallOnQuitControl() {
  const { autoInstallOnQuit } = useUpdatePreferences();
  const updateSettings = useSettingsStore((s) => s.update);
  return <Switch aria-label="Auto-install on quit" checked={autoInstallOnQuit} onCheckedChange={(value) => void updateSettings({ updates: { autoInstallOnQuit: value } })} />;
}

/** Settings on the About page. */
export const ABOUT = settingsPage("about", {
  version: {
    label: "Version",
    hint: "Currently installed build.",
    synonyms: "version about build release installed",
    Control: VersionControl,
  },
  updates: {
    label: "Updates",
    synonyms: "update check now upgrade new release install restart download",
    Row: UpdatesRow,
  },
  releaseLine: {
    label: "Release line",
    hint: "Stable follows tagged releases. Nightly follows automated prerelease builds when the project publishes them.",
    synonyms: "release channel stable nightly beta prerelease version update",
    configKey: "updates.channel",
    Control: ReleaseLineControl,
  },
  checkInterval: {
    label: "Check interval",
    hint: "How often to poll for new releases. Takes effect on next launch.",
    synonyms: "update check interval poll frequency",
    configKey: "updates.checkInterval",
    Control: CheckIntervalControl,
  },
  autoDownload: {
    label: "Auto-download",
    hint: "Download updates in the background as soon as they are available.",
    synonyms: "update download automatic background",
    configKey: "updates.autoDownload",
    Control: AutoDownloadControl,
  },
  autoInstallOnQuit: {
    label: "Auto-install on quit",
    hint: "Apply downloaded updates automatically when the app closes.",
    synonyms: "update install quit close restart automatic",
    configKey: "updates.autoInstallOnQuit",
    Control: AutoInstallOnQuitControl,
  },
});

/**
 * About settings section: shows the running app version, the current
 * auto-updater state, and controls for update behavior.
 *
 * The version is read from the Electron main process at startup, so it
 * always reflects the installed build without manual maintenance.
 */
export function AboutSection() {
  return (
    <SettingsGroup>
      {ABOUT.all.map((def) => <Setting key={def.id} def={def} />)}
    </SettingsGroup>
  );
}

const FAILURE_LABEL: Record<Extract<UpdateStatus, { state: "error" }>["failedOperation"], string> = {
  check: "Check failed",
  download: "Download failed",
  install: "Install failed",
};

/**
 * Short status label shown beside the button.
 * @param status - Current update status from the Electron main process.
 * @returns Human-readable label, or empty string when nothing noteworthy is happening.
 */
export function describeStatus(status: UpdateStatus): string {
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
      return status.installWhenIdle ? `v${status.version} installs when idle` : `v${status.version} ready`;
    case "error":
      return FAILURE_LABEL[status.failedOperation];
  }
}
