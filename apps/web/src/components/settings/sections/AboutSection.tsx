import { useEffect, useRef, useState } from "react";
import { useUpdateStore } from "@/stores/updateStore";
import { useShallow } from "zustand/shallow";
import { useSettingsStore } from "@/stores/settingsStore";
import { Setting } from "../Setting";
import { settingsGroup, settingsPage } from "../setting-def";
import { notRevertible, settingsValue } from "../setting-value";
import { SettingsGroup } from "../SettingsGroup";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { Settings, UpdateCheckInterval, UpdateReleaseLine } from "@mcode/contracts/models/settings";
import { ConfirmChannelDowngradeDialog } from "./ConfirmChannelDowngradeDialog";
import { VersionRow } from "./AboutVersion";
import { semverGt } from "@/lib/semver";

/** Segmented control options for update release line (electron-updater publish channel). */
const RELEASE_LINE_OPTIONS: { value: UpdateReleaseLine; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
];

/** Segmented control options for update check frequency. */
const INTERVAL_OPTIONS = [
  { value: "15min", label: "15m" },
  { value: "1hour", label: "1h" },
  { value: "4hours", label: "4h" },
  { value: "1day", label: "1d" },
  { value: "never", label: "Off" },
];

function getUpdatePreferences(settings: Settings): { autoDownload: boolean; autoInstallOnQuit: boolean; checkInterval: UpdateCheckInterval; releaseLine: UpdateReleaseLine } {
  return { autoDownload: settings.updates?.autoDownload ?? true, autoInstallOnQuit: settings.updates?.autoInstallOnQuit ?? true, checkInterval: settings.updates?.checkInterval ?? "4hours", releaseLine: settings.updates?.channel ?? "stable" };
}

function useUpdatePreferences() {
  return useSettingsStore(useShallow((s) => getUpdatePreferences(s.settings)));
}

function aboutBridge() {
  return typeof window !== "undefined" ? window.desktopBridge?.app : undefined;
}

/**
 * Revert's half of a release-line change: the running updater keeps its line until told, and with automatic checks
 * off nothing else would correct it. Revert never asks to confirm, so it never allows a downgrade.
 */
async function switchUpdaterBack(releaseLine: UpdateReleaseLine): Promise<string | null> {
  const bridge = aboutBridge();
  if (!bridge?.applyReleaseLine) return null;
  try {
    await bridge.applyReleaseLine({ releaseLine, allowDowngrade: false });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "the updater could not switch release line.";
  }
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

const APP = settingsGroup("App");
const UPDATES = settingsGroup("Updates");

/** Settings on the About page. */
export const ABOUT = settingsPage("about", {
  version: {
    label: "Version",
    group: APP,
    synonyms: "version about update upgrade check now build release installed changelog release notes what's new restart install download",
    value: notRevertible("An action that shows the build and checks for updates, not a stored value."),
    Row: VersionRow,
  },
  releaseLine: {
    label: "Release line",
    hint: "Nightly gets prerelease builds.",
    group: UPDATES,
    synonyms: "release channel stable nightly beta prerelease version update",
    value: settingsValue((s) => s.updates.channel, (channel) => ({ updates: { channel } }), undefined, switchUpdaterBack),
    Control: ReleaseLineControl,
  },
  checkInterval: {
    label: "Check interval",
    hint: "Takes effect on next launch.",
    group: UPDATES,
    synonyms: "update check interval poll frequency",
    value: settingsValue((s) => s.updates.checkInterval, (checkInterval) => ({ updates: { checkInterval } })),
    Control: CheckIntervalControl,
  },
  autoDownload: {
    label: "Auto-download",
    group: UPDATES,
    synonyms: "update download automatic background",
    value: settingsValue((s) => s.updates.autoDownload, (autoDownload) => ({ updates: { autoDownload } })),
    Control: AutoDownloadControl,
  },
  autoInstallOnQuit: {
    label: "Auto-install on quit",
    hint: "Installs a downloaded update when you quit Mcode.",
    group: UPDATES,
    synonyms: "update install quit close restart automatic",
    value: settingsValue((s) => s.updates.autoInstallOnQuit, (autoInstallOnQuit) => ({ updates: { autoInstallOnQuit } })),
    Control: AutoInstallOnQuitControl,
  },
});

/**
 * About settings section: the installed version with the updater's status and action,
 * then the update preferences. The version comes from the Electron main process at startup.
 */
export function AboutSection() {
  return (
    <div className="space-y-8">
      <SettingsGroup group={APP}>
        <Setting def={ABOUT.version} />
      </SettingsGroup>
      <SettingsGroup group={UPDATES}>
        {[ABOUT.releaseLine, ABOUT.checkInterval, ABOUT.autoDownload, ABOUT.autoInstallOnQuit].map((def) => <Setting key={def.id} def={def} />)}
      </SettingsGroup>
    </div>
  );
}
